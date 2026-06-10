import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  bindSessionWorkspace,
  getSessionWorkspace,
  clearSessionWorkspace,
  _sessionWorkspaceBindingsDir,
} from "./session-workspace"

let sandbox: string
let prevXdg: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-session-ws-"))
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = sandbox
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("session workspace binding", () => {
  test("bind then get round-trips the slug", async () => {
    await bindSessionWorkspace("ses_abc123", "spy-15m-mean-reversion.a3f8c9e2")
    expect(await getSessionWorkspace("ses_abc123")).toBe("spy-15m-mean-reversion.a3f8c9e2")
  })

  test("unbound session returns null", async () => {
    expect(await getSessionWorkspace("ses_never_bound")).toBeNull()
  })

  test("bindings do not bleed across sessions", async () => {
    await bindSessionWorkspace("ses_one", "spy-15m-mean-reversion.a3f8c9e2")
    await bindSessionWorkspace("ses_two", "btc-usdt-5m-momentum.a5694465")
    expect(await getSessionWorkspace("ses_one")).toBe("spy-15m-mean-reversion.a3f8c9e2")
    expect(await getSessionWorkspace("ses_two")).toBe("btc-usdt-5m-momentum.a5694465")
  })

  test("rebinding overwrites the previous slug", async () => {
    await bindSessionWorkspace("ses_x", "btc-mean-reversion-1h")
    await bindSessionWorkspace("ses_x", "spy-15m-pending")
    expect(await getSessionWorkspace("ses_x")).toBe("spy-15m-pending")
  })

  test("clear removes the binding and is idempotent", async () => {
    await bindSessionWorkspace("ses_y", "spy-15m-pending")
    await clearSessionWorkspace("ses_y")
    expect(await getSessionWorkspace("ses_y")).toBeNull()
    await clearSessionWorkspace("ses_y") // no throw
  })

  test("rejects invalid slugs", async () => {
    await expect(bindSessionWorkspace("ses_z", "Not A Slug!")).rejects.toThrow("invalid algo identifier")
  })

  test("rejects path-traversal session ids", async () => {
    await expect(bindSessionWorkspace("../escape", "spy-15m-pending")).rejects.toThrow("invalid session id")
    expect(await getSessionWorkspace("../escape")).toBeNull()
  })

  test("binding files live under the finny data dir", async () => {
    await bindSessionWorkspace("ses_loc", "spy-15m-pending")
    const dir = _sessionWorkspaceBindingsDir()
    expect(dir.startsWith(sandbox)).toBe(true)
    const raw = await fs.readFile(path.join(dir, "ses_loc"), "utf8")
    expect(raw.trim()).toBe("spy-15m-pending")
  })
})
