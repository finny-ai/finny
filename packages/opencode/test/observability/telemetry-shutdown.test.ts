import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  recordRunCompletion,
  settleWithDeadline,
  shutdownTelemetry,
  telemetryFlushResult,
} from "../../src/instrumentation"
import { runTelemetryAttributes, sessionTelemetryAttributes } from "../../src/telemetry/run-attributes"

describe("telemetry lifecycle", () => {
  test("shutdown is idempotent when no exporter is configured", async () => {
    expect(recordRunCompletion(0).recorded).toBe(true)
    expect(recordRunCompletion(0).recorded).toBe(false)
    expect(await shutdownTelemetry(5)).toBe("not_configured")
    expect(await shutdownTelemetry(5)).toBe("not_configured")
  })

  test("flush status reports exporter shutdown independently", () => {
    expect(telemetryFlushResult("completed")).toBe("completed")
    expect(telemetryFlushResult("timed_out")).toBe("timed_out")
    expect(telemetryFlushResult("failed")).toBe("failed")
    expect(telemetryFlushResult("not_configured")).toBe("not_run")
  })

  test("deadline settlement prefers completion that races the timer", async () => {
    const late = new Promise<"completed">((resolve) => setTimeout(() => resolve("completed"), 15))
    expect(await settleWithDeadline(late, 5, "timed_out")).toBe("completed")

    const never = new Promise<"completed">(() => {})
    expect(await settleWithDeadline(never, 5, "timed_out")).toBe("timed_out")

    const ok = Promise.resolve("completed" as const)
    expect(await settleWithDeadline(ok, 50, "timed_out")).toBe("completed")
  })

  test("run attributes are sourced from explicit harness identity", () => {
    const previous = {
      run: process.env.FINNY_RUN_ID,
      commit: process.env.FINNY_GIT_COMMIT,
      project: process.env.PHOENIX_PROJECT,
    }
    process.env.FINNY_RUN_ID = "run-1"
    process.env.FINNY_GIT_COMMIT = "abc"
    process.env.PHOENIX_PROJECT = "project-1"
    try {
      expect(runTelemetryAttributes()).toEqual({
        "service.name": "finny",
        "finny.run_id": "run-1",
        "git.commit": "abc",
        "openinference.project.name": "project-1",
      })
    } finally {
      if (previous.run === undefined) delete process.env.FINNY_RUN_ID
      else process.env.FINNY_RUN_ID = previous.run
      if (previous.commit === undefined) delete process.env.FINNY_GIT_COMMIT
      else process.env.FINNY_GIT_COMMIT = previous.commit
      if (previous.project === undefined) delete process.env.PHOENIX_PROJECT
      else process.env.PHOENIX_PROJECT = previous.project
    }
  })

  test("session attributes preserve parent and child attribution", () => {
    expect(sessionTelemetryAttributes("child", "parent")).toEqual({
      "session.id": "child",
      "finny.session_id": "child",
      "finny.parent_session_id": "parent",
      "finny.child_session_id": "child",
    })
  })

  test("child attribution includes the harness main session", () => {
    const previous = process.env.FINNY_MAIN_SESSION_ID
    process.env.FINNY_MAIN_SESSION_ID = "main"
    try {
      expect(sessionTelemetryAttributes("child", "parent")).toMatchObject({
        "finny.main_session_id": "main",
        "finny.parent_session_id": "parent",
        "finny.child_session_id": "child",
      })
    } finally {
      if (previous === undefined) delete process.env.FINNY_MAIN_SESSION_ID
      else process.env.FINNY_MAIN_SESSION_ID = previous
    }
  })

  test("CLI validation failures return through awaited telemetry shutdown", async () => {
    const env = {
      ...process.env,
      FINNY_HARNESS_MODE: "1",
      FINNY_RUN_ID: "run-cli-validation",
      FINNY_GIT_COMMIT: "commit-cli-validation",
      FINNY_MAIN_SESSION_ID: "ses-cli-validation",
      PHOENIX_PROJECT: "project-cli-validation",
    } as Record<string, string>
    delete env.PHOENIX_COLLECTOR_ENDPOINT
    delete env.OTEL_EXPORTER_OTLP_ENDPOINT
    const proc = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../src/index.ts"),
        "run",
        "--attach",
        "http://127.0.0.1:1",
        "--interactive",
        "--format",
        "json",
        "hello",
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("--interactive cannot be used with --format json")
    const telemetry = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === "harness_telemetry")
    expect(telemetry).toMatchObject({
      sessionID: "ses-cli-validation",
      appRuntime: "completed",
      manualTelemetry: "not_configured",
      flush: "not_run",
    })
  }, 10_000)

  test("SIGTERM emits harness telemetry before exiting", async () => {
    const collector = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 200 }),
    })
    const env = {
      ...process.env,
      FINNY_HARNESS_MODE: "1",
      FINNY_RUN_ID: "run-sigterm",
      FINNY_GIT_COMMIT: "commit-sigterm",
      FINNY_MAIN_SESSION_ID: "ses-sigterm",
      PHOENIX_PROJECT: "project-sigterm",
      PHOENIX_COLLECTOR_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    } as Record<string, string>
    const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/telemetry-signal.ts")], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let stdout = ""
    try {
      while (!stdout.includes('"type":"ready"')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("telemetry signal fixture exited before becoming ready")
        stdout += decoder.decode(chunk.value, { stream: true })
      }
      proc.kill("SIGTERM")
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        stdout += decoder.decode(chunk.value, { stream: true })
      }
      stdout += decoder.decode()
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      expect(exitCode).toBe(143)
      expect(stderr).toBe("")
      const telemetry = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === "harness_telemetry")
      expect(telemetry).toHaveLength(1)
      expect(telemetry[0]).toMatchObject({
        sessionID: "ses-sigterm",
        appRuntime: "completed",
        manualTelemetry: "completed",
        flush: "completed",
      })
    } finally {
      reader.releaseLock()
      proc.kill("SIGKILL")
      collector.stop(true)
    }
  }, 10_000)
})
