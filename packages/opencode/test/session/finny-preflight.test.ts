import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { getSessionWorkspace } from "@finny-ai/core/algo"
import { runFinnyPreflight, extractPromptText, PREFLIGHT_AGENTS } from "../../src/session/finny-preflight"
import { workspaceEnvDir } from "../../src/python/session-env"
import { Python } from "../../src/python/env"
import type { SessionStatus } from "../../src/session/status"

let sandbox: string
let prevXdg: string | undefined
let prevDisablePreflight: string | undefined

async function pythonAvailable(): Promise<boolean> {
  return Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
    .exited.then((code) => code === 0)
    .catch(() => false)
}

async function runPreflight(prompt: string, sessionID: string) {
  const statuses: SessionStatus.Info[] = []
  const result = await Effect.runPromise(
    runFinnyPreflight({
      sessionID: sessionID as any,
      agent: "build",
      prompt,
      setStatus: (status) =>
        Effect.sync(() => {
          statuses.push(status)
        }),
    }),
  )
  return { result, statuses }
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-preflight-"))
  prevXdg = process.env.XDG_DATA_HOME
  prevDisablePreflight = process.env.FINNY_DISABLE_SESSION_PREFLIGHT
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.FINNY_DISABLE_SESSION_PREFLIGHT
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  if (prevDisablePreflight === undefined) delete process.env.FINNY_DISABLE_SESSION_PREFLIGHT
  else process.env.FINNY_DISABLE_SESSION_PREFLIGHT = prevDisablePreflight
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("finny preflight", () => {
  test("extractPromptText ignores synthetic parts", () => {
    expect(
      extractPromptText({
        parts: [
          { type: "text", text: "hello", synthetic: false },
          { type: "text", text: "hidden", synthetic: true },
        ],
      }),
    ).toBe("hello")
  })

  test(
    "runs preflight for build prompts without a symbol",
    async () => {
      if (!(await pythonAvailable())) return
      const { result, statuses } = await runPreflight("options algo", "ses_options")
      expect(result).toBeDefined()
      expect(result!.workspaceSlug.startsWith("options-algo-strategy.")).toBe(true)
      expect(statuses.some((s) => s.type === "preflight" && s.phase === "ready")).toBe(true)
    },
    180_000,
  )

  test("skips non-preflight agents", async () => {
    expect(PREFLIGHT_AGENTS.has("build")).toBe(true)
    const result = await Effect.runPromise(
      runFinnyPreflight({
        sessionID: "ses_chat" as any,
        agent: "chat",
        prompt: "AAPL 5min momentum",
        setStatus: () => Effect.void,
      }),
    )
    expect(result).toBeUndefined()
  })

  test(
    "market prompt provisions workspace and workspace venv before returning",
    async () => {
      if (!(await pythonAvailable())) return
      const { result, statuses } = await runPreflight("AAPL 5min momentum strategy", "ses_aapl")

      expect(result).toBeDefined()
      expect(result!.workspaceSlug.startsWith("aapl-5m-momentum.")).toBe(true)
      expect(await getSessionWorkspace("ses_aapl")).toBe(result!.workspaceSlug)
      expect(result!.envDir).toBe(workspaceEnvDir(result!.workspacePath))

      const stat = await fs.stat(result!.python)
      expect(stat.isFile()).toBe(true)

      expect(statuses.some((s) => s.type === "preflight" && s.phase === "workspace")).toBe(true)
      expect(statuses.some((s) => s.type === "preflight" && s.phase === "ready")).toBe(true)
      const ready = statuses.findLast((s) => s.type === "preflight" && s.phase === "ready")
      expect(ready?.type === "preflight" && ready.steps?.length).toBeGreaterThan(2)
    },
    180_000,
  )

  test(
    "second prompt in the same session with ready env emits no setup statuses",
    async () => {
      const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
        .exited.then((code) => code === 0)
        .catch(() => false)
      if (!hasPython) return

      const prompt = "SPY 15-minute mean reversion strategy"
      const firstStatuses: SessionStatus.Info[] = []
      await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_fast" as any,
          agent: "build",
          prompt,
          setStatus: (status) =>
            Effect.sync(() => {
              firstStatuses.push(status)
            }),
        }),
      )
      expect(firstStatuses.length).toBeGreaterThan(0)

      const secondStatuses: SessionStatus.Info[] = []
      const second = await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_fast" as any,
          agent: "build",
          prompt: "continue and tighten the SPY 15-minute mean reversion stops",
          setStatus: (status) =>
            Effect.sync(() => {
              secondStatuses.push(status)
            }),
        }),
      )
      expect(second).toBeDefined()
      expect(secondStatuses).toHaveLength(0)
    },
    180_000,
  )

  test(
    "missing env marker triggers setup once",
    async () => {
      const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
        .exited.then((code) => code === 0)
        .catch(() => false)
      if (!hasPython) return

      const statuses: SessionStatus.Info[] = []
      const result = await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_marker" as any,
          agent: "build",
          prompt: "options algo",
          setStatus: (status) =>
            Effect.sync(() => {
              statuses.push(status)
            }),
        }),
      )
      expect(result).toBeDefined()
      expect(statuses.some((s) => s.type === "preflight" && s.phase === "ready")).toBe(true)
      await fs.rm(Python.envMarkerPath(result!.envDir), { force: true })

      const rerunStatuses: SessionStatus.Info[] = []
      await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_marker" as any,
          agent: "build",
          prompt: "continue with the options algo",
          setStatus: (status) =>
            Effect.sync(() => {
              rerunStatuses.push(status)
            }),
        }),
      )
      expect(rerunStatuses.some((s) => s.type === "preflight" && s.phase === "python")).toBe(true)
    },
    180_000,
  )

  test(
    "conflicting explicit symbol still rebinds and publishes setup",
    async () => {
      const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
        .exited.then((code) => code === 0)
        .catch(() => false)
      if (!hasPython) return

      await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_rebind" as any,
          agent: "build",
          prompt: "SPY 15-minute mean reversion strategy",
          setStatus: () => Effect.void,
        }),
      )

      const statuses: SessionStatus.Info[] = []
      const result = await Effect.runPromise(
        runFinnyPreflight({
          sessionID: "ses_rebind" as any,
          agent: "build",
          prompt: "now build a BTC 5-minute momentum strategy",
          setStatus: (status) =>
            Effect.sync(() => {
              statuses.push(status)
            }),
        }),
      )
      expect(result!.workspaceSlug.startsWith("btc-5m-momentum.")).toBe(true)
      expect(statuses.some((s) => s.type === "preflight" && s.phase === "workspace")).toBe(true)
    },
    180_000,
  )
})
