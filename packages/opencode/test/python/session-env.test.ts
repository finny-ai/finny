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
} from "../../src/python/session-env"
import { Python } from "../../src/python/env"

let sandbox: string
let prevXdg: string | undefined
let prevSharedPythonEnv: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-session-env-"))
  prevXdg = process.env.XDG_DATA_HOME
  prevSharedPythonEnv = process.env.FINNY_SHARED_PYTHON_ENV
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.FINNY_SHARED_PYTHON_ENV
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  if (prevSharedPythonEnv === undefined) delete process.env.FINNY_SHARED_PYTHON_ENV
  else process.env.FINNY_SHARED_PYTHON_ENV = prevSharedPythonEnv
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

  test("keeps the legacy .venv location available for reclaim discovery", () => {
    const ws = path.join(sandbox, "algos", "aapl-5m-strategy.abc123")
    expect(workspaceEnvDir(ws)).toBe(path.join(ws, WORKSPACE_VENV))
  })

  // `workspaceEnvDir` still honours an explicit operator-pinned environment; it is
  // now the legacy/reclaim discovery path, while resolution goes content-addressed.
  test("uses one explicit absolute production environment across workspaces", () => {
    const shared = path.join(sandbox, "shared-python")
    process.env.FINNY_SHARED_PYTHON_ENV = shared
    expect(workspaceEnvDir(path.join(sandbox, "algos", "a"))).toBe(shared)
    expect(workspaceEnvDir(path.join(sandbox, "algos", "b"))).toBe(shared)
  })

  test("rejects a relative shared production environment", () => {
    process.env.FINNY_SHARED_PYTHON_ENV = "relative-python"
    expect(() => workspaceEnvDir(path.join(sandbox, "algos", "a"))).toThrow(
      "FINNY_SHARED_PYTHON_ENV must be an absolute path",
    )
  })

  test("creates one content-addressed environment outside the workspace", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("aapl-5m-strategy")
    expect(await workspacePythonExists(ensured.dir)).toBe(false)

    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const env = await resolveWorkspacePythonEnv(ensured.dir, packages)
    expect(env.envDir).toBe(Python.sharedEnvDir(packages))
    expect(env.python).toBe(Python.pythonBinForEnvDir(env.envDir))
    expect(await workspacePythonExists(ensured.dir)).toBe(false)

    const probe = await Bun.spawn([env.python, "-c", "import pytz"], { stdout: "ignore", stderr: "pipe" }).exited
    expect(probe).toBe(0)
  }, 60_000)

  test("shares and serializes concurrent setup across workspaces with the same packages", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("spy-5m-momentum")
    const second = await ensureAlgoWorkspace("qqq-5m-momentum")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const [a, b] = await Promise.all([
      resolveWorkspacePythonEnv(ensured.dir, packages),
      resolveWorkspacePythonEnv(second.dir, packages),
    ])
    expect(a.python).toBe(b.python)
    expect(a.envDir).toBe(Python.sharedEnvDir(packages))
  })

  test("resolveSessionPythonEnv uses the shared package-set environment", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return

    const ensured = await ensureAlgoWorkspace("btc-5m-momentum")
    await bindSessionWorkspace("ses_env1", ensured.slug)
    await resolveWorkspacePythonEnv(ensured.dir, [{ spec: "pytz", importCheck: "pytz" }])

    const { resolveSessionPythonEnv } = await import("../../src/python/session-env")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const env = await resolveSessionPythonEnv("ses_env1", packages)
    expect(env.envDir).toBe(Python.sharedEnvDir(packages))
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
  }, 60_000)
})
