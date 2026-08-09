import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { deployQcPaper, listPaperDeployments, pushStrategyToQc, stopQcPaper } from "../../src/integration/qc-cloud"
import { isQcFixtureMode, qcConnectionState } from "../../src/integration/quantconnect"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalLedgerOverride = process.env.FINNY_QC_DEPLOYMENTS_FILE
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-qc-cloud-test-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_DEPLOYMENTS_FILE = path.join(home, "qc-paper-deployments.json")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalLedgerOverride === undefined) delete process.env.FINNY_QC_DEPLOYMENTS_FILE
  else process.env.FINNY_QC_DEPLOYMENTS_FILE = originalLedgerOverride
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
})

function algorithm() {
  return {
    algorithmId: "algo-fixture-1",
    userId: "u",
    name: "fixture-lean",
    code: "class Main(QCAlgorithm):\n    def Initialize(self): pass",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({ symbol: "SPY", asset_class: "equity", interval: "5m", required_history_bars: 24 }),
    time_created: 0,
    time_updated: 0,
  }
}

describe("QC cloud fixture mode (no credentials)", () => {
  test("enables fixture mode and reports it in connection state", async () => {
    process.env.QC_FIXTURE = "1"
    expect(isQcFixtureMode()).toBe(true)
    const state = await qcConnectionState()
    expect(state.fixture).toBe(true)
    expect(state.connected).toBe(false)
  })

  test("pushes strategies to deterministic fixture projects", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const first = await pushStrategyToQc({ algorithm: algorithm() })
    const second = await pushStrategyToQc({ algorithm: algorithm() })
    expect(first.mode).toBe("fixture")
    expect(first.projectId).toBe(second.projectId)
    expect(first.projectId).toMatch(/^qc-fixture-/)
  })

  test("records and stops paper deployments in the local ledger", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const deploy = await deployQcPaper({ algorithm: algorithm() })
    expect(deploy.ok).toBe(true)
    expect(deploy.status).toBe("running")
    const ledger = await listPaperDeployments()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.algorithmName).toBe("fixture-lean")
    const stopped = await stopQcPaper(deploy.deploymentId)
    expect(stopped?.status).toBe("stopped")
    expect((await listPaperDeployments())[0]!.status).toBe("stopped")
  })
})
