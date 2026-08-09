import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  qcBacktestWait,
  qcCompileWait,
  qcLiveCreate,
  qcProjectCreate,
  qcProjectsRead,
} from "../../src/integration/qc-client"
import { QC_PROVIDER_ID } from "../../src/integration/quantconnect"
import {
  buildQcBrokerageSettings,
  deployQcLive,
  runQcCloudBacktest,
  listPaperDeployments,
} from "../../src/integration/qc-cloud"

const CREDENTIALS = { userId: "1001200", apiToken: "cf17c7b00ceb48f3ac6fca5f8a48a6e2" }

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalLedgerOverride = process.env.FINNY_QC_DEPLOYMENTS_FILE
const cleanups: string[] = []
let originalFetch: typeof fetch

function mockQc(handler: (path: string, body: unknown) => unknown) {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const apiPath = new URL(url).pathname.replace(/\/api\/v2$/, "").replace(/\/api\/v2\//, "/")
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return new Response(JSON.stringify(handler(apiPath, body)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFetch) globalThis.fetch = originalFetch
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalLedgerOverride === undefined) delete process.env.FINNY_QC_DEPLOYMENTS_FILE
  else process.env.FINNY_QC_DEPLOYMENTS_FILE = originalLedgerOverride
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  delete process.env.QC_FIXTURE
  delete process.env.FINNY_QC_FIXTURE
})

function tempHome(): string {
  const home = `/tmp/finny-qc-client-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_DEPLOYMENTS_FILE = path.join(home, "qc-paper-deployments.json")
  cleanups.push(home)
  return home
}

describe("QC client", () => {
  test("reads and parses the project list", async () => {
    mockQc((apiPath) => {
      expect(apiPath).toBe("/projects/read")
      return {
        success: true,
        projects: [
          {
            projectId: 23456789,
            organizationId: "5cad178b20a1d52567b534553413b691",
            name: "My Algorithm",
            language: "Py",
            ownerId: 1,
            modified: "2026-08-08T00:00:00Z",
            created: "2026-08-01T00:00:00Z",
            leanVersionId: 17202,
          },
        ],
      }
    })
    const projects = await qcProjectsRead(CREDENTIALS)
    expect(projects).toHaveLength(1)
    expect(projects[0].projectId).toBe(23456789)
    expect(projects[0].language).toBe("Py")
  })

  test("creates a project with QC language ids", async () => {
    const seen: string[] = []
    mockQc((apiPath, body) => {
      seen.push(apiPath)
      if (apiPath === "/projects/create") {
        return { success: true, projects: [{ projectId: 11, name: (body as any).name, language: (body as any).language }] }
      }
      throw new Error(`unexpected ${apiPath}`)
    })
    const python = await qcProjectCreate(CREDENTIALS, { name: "Finny Test v1", language: "python" })
    expect(python.projectId).toBe(11)
    expect((seen.length, python.project.language)).toBe("Py")
    const csharp = await qcProjectCreate(CREDENTIALS, { name: "Finny Test v2", language: "csharp" })
    expect(csharp.project.language).toBe("C#")
  })

  test("polls compile until BuildSuccess", async () => {
    let calls = 0
    mockQc((apiPath) => {
      if (apiPath === "/compile/create") return { success: true, compileId: "c1", state: "InQueue" }
      expect(apiPath).toBe("/compile/read")
      calls += 1
      return { success: true, compile: { compileId: "c1", state: calls >= 2 ? "BuildSuccess" : "InQueue" } }
    })
    const result = await qcCompileWait(CREDENTIALS, { projectId: 11, compileId: "c1" }, { intervalMs: 1, timeoutMs: 5000 })
    expect(result.state).toBe("BuildSuccess")
    expect(calls).toBe(2)
  })

  test("polls backtest until Completed and surfaces statistics", async () => {
    let calls = 0
    mockQc((apiPath) => {
      if (apiPath === "/backtests/create") return { success: true, backtests: [{ backtestId: "bt1" }] }
      expect(apiPath).toBe("/backtests/read")
      calls += 1
      if (calls < 2) {
        return { success: true, backtest: { backtestId: "bt1", status: "In Progress...", progress: 0.4 } }
      }
      return {
        success: true,
        backtest: {
          backtestId: "bt1",
          status: "Completed.",
          progress: 1,
          statistics: { "Total Return": "12.34%", "Sharpe Ratio": "1.98", "Drawdown": "-8.10%", "Total Trades": "42" },
        },
      }
    })
    const result = await qcBacktestWait(CREDENTIALS, { projectId: 11, backtestId: "bt1" }, { intervalMs: 1, timeoutMs: 5000 })
    expect(result.status).toBe("Completed.")
    expect(result.statistics?.["Sharpe Ratio"]).toBe("1.98")
  })

  test("builds keyed brokerage settings for live create", async () => {
    const seen: string[] = []
    mockQc((apiPath, body) => {
      seen.push(apiPath)
      expect(apiPath).toBe("/live/create")
      const payload = body as Record<string, any>
      expect(payload.projectId).toBe(11)
      expect(payload.nodeId).toBe("LN-MICRO")
      expect(payload.brokerage.QuantConnectBrokerageSettings.id).toBe("QuantConnectBrokerage")
      expect(payload.brokerage.QuantConnectBrokerageSettings.cash).toEqual([{ amount: 25000, currency: "USD" }])
      expect(payload.dataProviders.QuantConnectBrokerage.id).toBe("QuantConnectBrokerage")
      return {
        success: true,
        live: { deployId: "L-abc123", projectId: 11, status: "InQueue" },
      }
    })
    const deployment = await qcLiveCreate(CREDENTIALS, {
      projectId: 11,
      compileId: "c1",
      nodeId: "LN-MICRO",
      brokerage: {
        QuantConnectBrokerageSettings: {
          id: "QuantConnectBrokerage",
          holdings: [],
          cash: [{ amount: 25000, currency: "USD" }],
        },
      },
      dataProviders: { QuantConnectBrokerage: { id: "QuantConnectBrokerage" } },
    })
    expect(deployment.deployId).toBe("L-abc123")
    expect(seen).toEqual(["/live/create"])
  })
})

describe("QC cloud track", () => {
  test("reports a running QC deployment as ok and keeps the ledger running", async () => {
    tempHome()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "cf17c7b00ceb48f3ac6fca5f8a48a6e2", metadata: { userId: "1001200" } },
    })
    const seen: string[] = []
    mockQc((apiPath) => {
      seen.push(apiPath)
      if (apiPath === "/live/create") return { success: true, live: { deployId: "L-run-1", projectId: 42, status: "InQueue" } }
      if (apiPath === "/live/read") return { success: true, live: { deployId: "L-run-1", projectId: 42, status: "Running" } }
      throw new Error(`unexpected ${apiPath}`)
    })
    const algorithm = {
      algorithmId: "00000000-0000-4000-8000-000000000010",
      userId: "u1",
      name: "live-running",
      version: 1,
      status: "saved",
      code: "class X(QCAlgorithm): pass",
      language: "python",
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const outcome = await deployQcLive({
      algorithm: algorithm as any,
      projectId: "42",
      compileId: "c1",
      nodeId: "LN-MICRO",
      brokerKind: "qc_paper",
      capital: 10000,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe("running")
    const ledger = await listPaperDeployments()
    expect(ledger.find((entry) => entry.deploymentId === "L-run-1")?.status).toBe("running")
  })

  test("fails closed on a RuntimeError deployment and stops the remote run", async () => {
    tempHome()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "cf17c7b00ceb48f3ac6fca5f8a48a6e2", metadata: { userId: "1001200" } },
    })
    const seen: string[] = []
    mockQc((apiPath) => {
      seen.push(apiPath)
      if (apiPath === "/live/create") return { success: true, live: { deployId: "L-err-1", projectId: 42, status: "InQueue" } }
      if (apiPath === "/live/read") {
        return { success: true, live: { deployId: "L-err-1", projectId: 42, status: "RuntimeError", message: "strategy crashed" } }
      }
      if (apiPath === "/live/stop") return { success: true, live: { deployId: "L-err-1", projectId: 42, status: "Stopped" } }
      throw new Error(`unexpected ${apiPath}`)
    })
    const algorithm = {
      algorithmId: "00000000-0000-4000-8000-000000000011",
      userId: "u1",
      name: "live-error",
      version: 1,
      status: "saved",
      code: "class X(QCAlgorithm): pass",
      language: "python",
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const outcome = await deployQcLive({
      algorithm: algorithm as any,
      projectId: "42",
      compileId: "c1",
      nodeId: "LN-MICRO",
      brokerKind: "qc_paper",
      capital: 10000,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe("stopped")
    expect(seen).toContain("/live/stop")
    const ledger = await listPaperDeployments()
    expect(ledger.find((entry) => entry.deploymentId === "L-err-1")?.status).toBe("stopped")
  })

  test("runs the real backtest flow end to end with mapped statistics", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "cf17c7b00ceb48f3ac6fca5f8a48a6e2", metadata: { userId: "1001200" } },
    })
    mockQc((apiPath, body) => {
      if (apiPath === "/projects/create") return { success: true, projects: [{ projectId: 42, language: "Py" }] }
      if (apiPath === "/files/create") return { success: true }
      if (apiPath === "/compile/create") return { success: true, compileId: "c42", state: "InQueue" }
      if (apiPath === "/compile/read") return { success: true, compile: { compileId: "c42", state: "BuildSuccess" } }
      if (apiPath === "/backtests/create") {
        const payload = body as Record<string, any>
        expect(payload.compileId).toBe("c42")
        return { success: true, backtests: [{ backtestId: "bt42" }] }
      }
      if (apiPath === "/backtests/read") {
        return {
          success: true,
          backtest: {
            backtestId: "bt42",
            status: "Completed.",
            progress: 1,
            statistics: {
              "Total Return": "5.20%",
              "Sharpe Ratio": "1.10",
              "Drawdown": "-4.00%",
              "Total Trades": "12",
              "Fees": "-$3.40",
            },
          },
        }
      }
      throw new Error(`unexpected ${apiPath}`)
    })
    const home = tempHome()
    const algorithm = {
      algorithmId: "00000000-0000-4000-8000-000000000001",
      userId: "u1",
      name: "qc-client-test",
      version: 1,
      status: "saved",
      code: "class BasicTemplateAlgorithm(QCAlgorithm): pass",
      language: "python",
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const outcome = await runQcCloudBacktest({
      algorithm: algorithm as any,
      ohlcvCsv: "timestamp,open,high,low,close,volume\n",
      interval: "5min",
      capital: 10000,
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      walkForwardFolds: 0,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.mode).toBe("cloud")
      expect(outcome.backtestId).toBe("bt42")
      expect(outcome.stats?.total_return).toBeCloseTo(5.2, 6)
      expect(outcome.stats?.sharpe).toBeCloseTo(1.1, 6)
      expect(outcome.stats?.total_trades).toBe(12)
      expect(outcome.stats?.mode).toBe("cloud")
    }
    await fs.rm(home, { recursive: true, force: true })
  })

  test("builds Alpaca and Binance brokerage settings from stored accounts", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "qc-token", metadata: { userId: "1001200" } },
      "alpaca-paper": {
        type: "api",
        key: "alpaca-secret-1",
        metadata: { keyId: "PK123", mode: "paper" },
      },
      "binance-testnet-acct": {
        type: "api",
        key: "binance-secret-1",
        metadata: { keyId: "BK123", mode: "testnet" },
      },
    })
    const alpaca = await buildQcBrokerageSettings({
      brokerKind: "alpaca",
      brokerProviderID: "alpaca-paper",
      capital: 10000,
    })
    const alpacaSettings = alpaca.brokerage.AlpacaBrokerageSettings as Record<string, unknown>
    expect(alpacaSettings["alpaca-api-key"]).toBe("PK123")
    expect(alpacaSettings["alpaca-api-secret"]).toBe("alpaca-secret-1")
    expect(alpacaSettings["alpaca-environment"]).toBe("paper")
    const binance = await buildQcBrokerageSettings({
      brokerKind: "binance",
      brokerProviderID: "binance-testnet-acct",
      capital: 10000,
    })
    const binanceSettings = binance.brokerage.BinanceBrokerageSettings as Record<string, unknown>
    expect(binanceSettings["binance-api-key"]).toBe("BK123")
    expect(binanceSettings["binance-use-testnet"]).toBe("paper")
  })

  test("records fixture deployments in the durable ledger", async () => {
    tempHome()
    process.env.QC_FIXTURE = "1"
    const algorithm = {
      algorithmId: "00000000-0000-4000-8000-000000000002",
      userId: "u1",
      name: "fixture-deploy",
      version: 1,
      status: "saved",
      code: "class X(QCAlgorithm): pass",
      language: "python",
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const outcome = await deployQcLive({
      algorithm: algorithm as any,
      projectId: "qc-fixture-abc",
      compileId: "c1",
      nodeId: "LN-MICRO",
      brokerKind: "qc_paper",
      capital: 10000,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.mode).toBe("fixture")
    const ledger = await listPaperDeployments()
    expect(ledger.some((entry) => entry.deploymentId === outcome.deploymentId)).toBe(true)
    expect(ledger.find((entry) => entry.deploymentId === outcome.deploymentId)?.brokerKind).toBe("qc_paper")
  })
})
