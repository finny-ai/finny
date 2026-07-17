import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  commitRequestSpec,
  assertNoRuntimeRequestSpecPath,
  migrateLegacyWorkspaceRequest,
  readRequestSpec,
  readRequestSpecHistory,
  requestProjectionMatches,
  writeRequestSpecProjection,
} from "../../src/agent/request-spec"

let sandbox: string | undefined
let previousFinnyHome: string | undefined

async function setup() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-request-spec-"))
  previousFinnyHome = process.env.FINNY_HOME
  process.env.FINNY_HOME = sandbox
  const workspace = path.join(sandbox, "algos", "spy-1d-sma")
  await fs.mkdir(workspace, { recursive: true })
  const spec = await commitRequestSpec({
    requestID: "ses_request_integrity",
    identity: {
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_asset_class: "equity",
      requested_algorithm_name: "spy-sma-200",
      requested_start: "2018-01-01",
      requested_end: "2025-12-31",
    },
    actor: "user",
    reason: "initial explicit user request",
  })
  await writeRequestSpecProjection({ workspaceDir: workspace, spec })
  return { workspace, spec }
}

afterEach(async () => {
  if (previousFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = previousFinnyHome
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true })
  sandbox = undefined
})

describe("runtime RequestSpec integrity", () => {
  test("model shell commands cannot rewrite, rename, or delete the runtime store", () => {
    for (const command of [
      "echo '{}' > $FINNY_HOME/request-specs/ses/current.json",
      "mv ~/.local/share/finny/request-specs/ses/current.json /tmp/stolen.json",
      "rm -rf /tmp/finny/request-specs",
    ]) {
      expect(() => assertNoRuntimeRequestSpecPath({ command })).toThrow("runtime-owned")
    }
  })

  test("model shell commands cannot hide runtime storage behind string concatenation", () => {
    for (const command of [
      `python3 -c 'from pathlib import Path; print(Path.home() / "request-" + "specs")'`,
      `python3 - <<'PY'\nimport os\nprint(os.path.join('/tmp', "request-" + "specs", 'current.json'))\nPY`,
    ]) {
      expect(() => assertNoRuntimeRequestSpecPath({ command })).toThrow("runtime-owned")
    }
  })

  test("model shell commands cannot access runtime state databases directly", () => {
    for (const command of [
      `sqlite3 ~/.local/share/opencode/opencode.db 'select * from session'`,
      `python3 -c 'import sqlite3; sqlite3.connect("/tmp/opencode-local.db")'`,
      `rm -f /tmp/opencode-dev.db-wal`,
    ]) {
      expect(() => assertNoRuntimeRequestSpecPath({ command })).toThrow("runtime-owned")
    }
  })

  test("legacy workspace identity migrates once and then stops being authoritative", async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-request-spec-legacy-"))
    previousFinnyHome = process.env.FINNY_HOME
    process.env.FINNY_HOME = sandbox
    const workspace = path.join(sandbox, "algos", "legacy-spy")
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(
      path.join(workspace, "request.json"),
      JSON.stringify({ requested_symbol: "SPY", requested_interval: "1d", requested_asset_class: "equity" }),
    )
    const migrated = (await migrateLegacyWorkspaceRequest({ requestID: "ses_legacy", workspaceDir: workspace }))!
    expect(migrated).toMatchObject({ requested_symbol: "SPY", request_version: 1 })
    expect(migrated.user_approvals[0]).toMatchObject({ actor: "migration", state: "legacy" })

    await fs.writeFile(path.join(workspace, "request.json"), JSON.stringify({ requested_symbol: "QQQ" }))
    const unchanged = (await migrateLegacyWorkspaceRequest({ requestID: "ses_legacy", workspaceDir: workspace }))!
    expect(unchanged.requested_symbol).toBe("SPY")
    expect(unchanged.request_version).toBe(1)
  })

  test("workspace rewrite, rename, and deletion cannot change authoritative identity", async () => {
    const { workspace, spec } = await setup()
    const projection = path.join(workspace, "request.json")

    await fs.chmod(projection, 0o600)
    await fs.writeFile(projection, JSON.stringify({ requested_symbol: "QQQ", request_version: 999 }))
    expect(await requestProjectionMatches({ workspaceDir: workspace, spec })).toBe(false)
    expect((await readRequestSpec({ requestID: spec.request_id }))?.requested_symbol).toBe("SPY")

    await fs.rename(projection, path.join(workspace, "request.old.json"))
    expect(await requestProjectionMatches({ workspaceDir: workspace, spec })).toBe(false)
    await writeRequestSpecProjection({
      workspaceDir: workspace,
      spec: (await readRequestSpec({ requestID: spec.request_id }))!,
    })

    await fs.rm(projection)
    expect(await requestProjectionMatches({ workspaceDir: workspace, spec })).toBe(false)
    await fs.rm(workspace, { recursive: true, force: true })
    await fs.mkdir(workspace, { recursive: true })
    const runtime = (await readRequestSpec({ requestID: spec.request_id }))!
    await writeRequestSpecProjection({ workspaceDir: workspace, spec: runtime })
    expect(await requestProjectionMatches({ workspaceDir: workspace, spec: runtime })).toBe(true)
    expect(runtime).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_start: "2018-01-01",
      requested_end: "2025-12-31",
    })
  })

  test("semantic changes append an approved, actor-attributed version event", async () => {
    const { spec } = await setup()
    const amended = await commitRequestSpec({
      requestID: spec.request_id,
      identity: { requested_end: "2026-06-30" },
      actor: "user",
      reason: "user approved extending the end date",
      approvalState: "approved",
    })
    expect(amended.request_version).toBe(2)
    expect(amended.content_hash).not.toBe(spec.content_hash)
    const history = await readRequestSpecHistory({ requestID: spec.request_id })
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({
      from_version: 1,
      to_version: 2,
      actor: "user",
      reason: "user approved extending the end date",
      approval_state: "approved",
    })
  })
})
