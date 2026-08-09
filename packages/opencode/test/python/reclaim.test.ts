import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bindSessionWorkspace, ensureAlgoWorkspace } from "@finny-ai/core/algo"
import { Python } from "../../src/python/env"
import { applyPythonEnvReclaim, planPythonEnvReclaim } from "../../src/python/reclaim"

let sandbox: string
let previousFinnyHome: string | undefined

async function fakeManagedEnv(envDir: string, packages = [{ spec: "demo", importCheck: "demo" }]) {
  const python = Python.pythonBinForEnvDir(envDir)
  await fs.mkdir(path.dirname(python), { recursive: true })
  await fs.writeFile(python, "")
  await fs.writeFile(
    Python.envMarkerPath(envDir),
    JSON.stringify({
      installer: "uv",
      python,
      packages,
      verifiedAt: "2025-01-01T00:00:00.000Z",
    }) + "\n",
  )
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-reclaim-"))
  previousFinnyHome = process.env.FINNY_HOME
  process.env.FINNY_HOME = path.join(sandbox, "finny")
})

afterEach(async () => {
  if (previousFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = previousFinnyHome
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("Python environment reclaim", () => {
  test("reports marker-verified legacy envs without deleting them", async () => {
    const workspace = await ensureAlgoWorkspace("legacy-unused")
    const envDir = path.join(workspace.dir, ".venv")
    await fakeManagedEnv(envDir)

    const plan = await planPythonEnvReclaim()

    expect(plan.dryRun).toBe(true)
    expect(plan.candidates.map((item) => item.path)).toContain(envDir)
    expect(await fs.stat(envDir)).toBeTruthy()
  })

  test("skips unknown, symlinked, and session-bound workspace envs", async () => {
    const unknown = await ensureAlgoWorkspace("unknown-env")
    await fs.mkdir(path.join(unknown.dir, ".venv"), { recursive: true })

    const bound = await ensureAlgoWorkspace("bound-env")
    await fakeManagedEnv(path.join(bound.dir, ".venv"))
    await bindSessionWorkspace("session-bound", bound.slug)

    const target = path.join(sandbox, "outside")
    await fakeManagedEnv(target)
    const linked = await ensureAlgoWorkspace("linked-env")
    await fs.symlink(target, path.join(linked.dir, ".venv"))

    const plan = await planPythonEnvReclaim()

    expect(plan.candidates).toHaveLength(0)
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: path.join(unknown.dir, ".venv") }),
        expect.objectContaining({ path: path.join(bound.dir, ".venv"), reason: expect.stringContaining("session") }),
        expect.objectContaining({ path: path.join(linked.dir, ".venv") }),
      ]),
    )
  })

  test("applies only an unchanged dry-run plan", async () => {
    const workspace = await ensureAlgoWorkspace("apply-env")
    const envDir = path.join(workspace.dir, ".venv")
    await fakeManagedEnv(envDir)
    const plan = await planPythonEnvReclaim()

    const result = await applyPythonEnvReclaim(plan)

    expect(result.removed.map((item) => item.path)).toEqual([envDir])
    const removedStat = await fs.stat(envDir).catch((error) => error)
    expect(removedStat).toMatchObject({ code: "ENOENT" })
  })

  test("rechecks session protection after planning", async () => {
    const workspace = await ensureAlgoWorkspace("late-bound-env")
    const envDir = path.join(workspace.dir, ".venv")
    await fakeManagedEnv(envDir)
    const plan = await planPythonEnvReclaim()
    await bindSessionWorkspace("late-session", workspace.slug)

    const result = await applyPythonEnvReclaim(plan)

    expect(result.removed).toHaveLength(0)
    expect(result.skipped).toContainEqual({
      path: envDir,
      reason: "changed or became active after the dry-run plan",
    })
    expect(await fs.stat(envDir)).toBeTruthy()
  })

  test("retains recent shared envs and skips a live leased environment", async () => {
    const packages = [{ spec: "demo", importCheck: "demo" }]
    const envDir = Python.sharedEnvDir(packages)
    await fakeManagedEnv(envDir, packages)
    const old = new Date("2025-01-01T00:00:00.000Z")
    await fs.utimes(Python.envMarkerPath(envDir), old, old)
    await fs.mkdir(path.join(envDir, ".finny-env-leases"))
    await fs.writeFile(path.join(envDir, ".finny-env-leases", String(process.pid)), "")

    const plan = await planPythonEnvReclaim({
      maxAgeDays: 1,
      keepShared: 0,
      now: new Date("2026-01-01T00:00:00.000Z"),
    })

    expect(plan.candidates).toHaveLength(0)
    expect(plan.skipped).toContainEqual({
      path: envDir,
      reason: "environment has a live Finny process lease",
    })
  })
})
