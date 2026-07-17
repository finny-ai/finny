import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureAlgoWorkspace, bindSessionWorkspace } from "@finny-ai/core/algo"
import {
  workspaceEnvDir,
  workspacePythonExists,
  resolveWorkspacePythonEnv,
  isWorkspaceEnvReady,
  WORKSPACE_VENV,
  SESSION_PREFLIGHT_PACKAGES,
} from "../../src/python/session-env"
import { Python } from "../../src/python/env"

let sandbox: string
let prevXdg: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-session-env-"))
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = sandbox
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("workspace session env", () => {
  test("uv-created environments are seeded for the pip fallback", () => {
    expect(Python.uvVenvCommand("uv", "/tmp/finny-env", "python3")).toEqual([
      "uv",
      "venv",
      "/tmp/finny-env",
      "--python",
      "python3",
      "--seed",
    ])
  })

  test("uses .venv under the workspace directory", () => {
    const ws = path.join(sandbox, "algos", "aapl-5m-strategy.abc123")
    expect(workspaceEnvDir(ws)).toBe(path.join(ws, WORKSPACE_VENV))
  })

  test(
    "creates workspace venv and installs packages",
    async () => {
      const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
        .exited.then((code) => code === 0)
        .catch(() => false)
      if (!hasPython) return

      const ensured = await ensureAlgoWorkspace("aapl-5m-strategy")
      expect(await workspacePythonExists(ensured.dir)).toBe(false)

      const env = await resolveWorkspacePythonEnv(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])
      expect(env.envDir).toBe(workspaceEnvDir(ensured.dir))
      expect(env.python).toBe(Python.pythonBinForEnvDir(env.envDir))
      expect(await workspacePythonExists(ensured.dir)).toBe(true)

      const probe = await Bun.spawn([env.python, "-c", "import pytz"], { stdout: "ignore", stderr: "pipe" }).exited
      expect(probe).toBe(0)
    },
    60_000,
  )

  test("serializes concurrent setup for the same workspace env", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("spy-5m-momentum")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const [a, b] = await Promise.all([
      resolveWorkspacePythonEnv(ensured.dir, packages),
      resolveWorkspacePythonEnv(ensured.dir, packages),
    ])
    expect(a.python).toBe(b.python)
  })

  test("resolveSessionPythonEnv prefers bound workspace venv", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("btc-5m-momentum")
    await bindSessionWorkspace("ses_env1", ensured.slug)
    await resolveWorkspacePythonEnv(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])

    const { resolveSessionPythonEnv } = await import("../../src/python/session-env")
    const env = await resolveSessionPythonEnv("ses_env1", [{ spec: "pytz", importCheck: "pytz" }])
    expect(env.envDir).toBe(workspaceEnvDir(ensured.dir))
  })

  test("env marker invalidates when package specs change", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("spy-5m-marker")
    await resolveWorkspacePythonEnv(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])
    expect(await isWorkspaceEnvReady(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])).toBe(true)
    expect(await isWorkspaceEnvReady(ensured.dir, [{ spec: "numpy", importCheck: "numpy" }])).toBe(false)
  })

  test("falls back to pip when uv is unavailable", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const prevUv = process.env.FINNY_UV_BIN
    process.env.FINNY_UV_BIN = "/definitely/missing/uv"
    try {
      const ensured = await ensureAlgoWorkspace("spy-5m-pip-fallback")
      const env = await resolveWorkspacePythonEnv(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])
      const marker = await Python.readEnvMarker(env.envDir)
      expect(marker?.installer).toBe("pip")
    } finally {
      if (prevUv === undefined) delete process.env.FINNY_UV_BIN
      else process.env.FINNY_UV_BIN = prevUv
    }
  })
})
