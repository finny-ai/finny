import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LeanAdapter } from "../../src/backtest/lean/adapter"
import { LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST, runtimeProfileV1 } from "../../src/backtest/lean/contracts"
import { writeLeanSourceFile } from "../../src/backtest/lean/source-store"
import type { LeanAdapterContextV1, LeanAdapterResultV1 } from "../../src/backtest/lean/types"
import { runQcCompositeQualification } from "../../src/integration/qc-composite"
import { attachProject } from "../../src/integration/qc-sync"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalControl = process.env.FINNY_QC_CONTROL_DIR
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-qc-composite-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_CONTROL_DIR = path.join(home, "qc-control")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
  if (originalControl === undefined) delete process.env.FINNY_QC_CONTROL_DIR
  else process.env.FINNY_QC_CONTROL_DIR = originalControl
})

const ALGO_ID = "01234567-89ab-cdef-0123-456789abcdef"

function algorithm() {
  return {
    algorithmId: ALGO_ID,
    userId: "u",
    name: "qc-composite-algo",
    code: "class Main(QCAlgorithm):\n    def Initialize(self): pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({
      symbol: "SPY",
      asset_class: "equity",
      interval: "1h",
      required_history_bars: 1,
      runtime: { profile: runtimeProfileV1("qc_cloud") },
    }),
    time_created: 0,
    time_updated: 0,
  }
}

function fixtureCsv(): string {
  const lines = ["timestamp,open,high,low,close,volume"]
  for (let day = 1; day <= 31; day++) {
    lines.push(`2026-01-${String(day).padStart(2, "0")}T10:00:00Z,100,101,99,100.5,1000`)
  }
  return lines.join("\n") + "\n"
}

describe("QC composite qualification (fixture mode)", () => {
  test("runs the fixture cloud leg on attested bars and evaluates canonical gates", async () => {
    const home = isolatedHome()
    process.env.QC_FIXTURE = "1"
    await fs.mkdir(home, { recursive: true })
    const algo = algorithm()
    await writeLeanSourceFile({
      algorithm: algo,
      relativePath: "main.py",
      content: "class Main(QCAlgorithm):\n    def Initialize(self): pass\n",
    })
    await attachProject({
      algorithm: algo,
      projectId: 24058693,
      projectName: "Fixture Python",
      language: "python",
    })

    const startEpoch = Math.floor(Date.UTC(2026, 0, 1, 15, 0, 0) / 1000)
    const equityValues = Array.from({ length: 31 }, (_, i) => {
      const equity = 10000 + i * 16 + (i % 3)
      return [startEpoch + i * 86400, equity, equity + 2, equity - 2, equity]
    })
    const orders = {
      "1": { orderId: "1", symbol: { value: "SPY" }, status: 3, quantity: 10, price: 100, direction: "Buy", tag: "", time: "2026-01-02T15:00:00Z" },
      "2": { orderId: "2", symbol: { value: "SPY" }, status: 3, quantity: 10, price: 104, direction: "Sell", tag: "", time: "2026-01-10T15:00:00Z" },
      "3": { orderId: "3", symbol: { value: "SPY" }, status: 3, quantity: 10, price: 101, direction: "Buy", tag: "", time: "2026-01-12T15:00:00Z" },
      "4": { orderId: "4", symbol: { value: "SPY" }, status: 3, quantity: 10, price: 105, direction: "Sell", tag: "", time: "2026-01-20T15:00:00Z" },
    }

    const runSpy = spyOn(LeanAdapter.prototype, "run").mockImplementation(
      async (input: LeanAdapterContextV1): Promise<LeanAdapterResultV1> => {
        await fs.writeFile(
          path.join(input.resultsDir, "Main.json"),
          JSON.stringify({
            orders,
            orderEvents: [],
            charts: { "Strategy Equity": { series: { Equity: { values: equityValues } } } },
          }),
          "utf8",
        )
        await fs.writeFile(path.join(input.resultsDir, "Main-summary.json"), "{}", "utf8")
        return {
          ok: true,
          artifacts: {
            schema: "finny.lean_run_artifacts",
            version: 1,
            orders: [],
            fills: [],
            rejections: [],
            equityCurve: [],
            rawStatistics: {},
            leanResultPath: "",
            leanSummaryPath: "",
          },
          container: {
            imageDigest: LEAN_PINNED_IMAGE_DIGEST,
            leanCommit: LEAN_PINNED_COMMIT,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 0,
          },
        }
      },
    )

    try {
      const outcome = await runQcCompositeQualification({
        algorithm: algo,
        interval: "1h",
        capital: 10000,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        local: {
          ok: true,
          runId: "run-fixture",
          identityHash: "id".repeat(32),
          runtimeHash: "rt".repeat(32),
          engine: "lean_python",
          verdict: "recommended_for_paper",
          metrics: {},
        },
        fixtureCsv: fixtureCsv(),
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.mode).toBe("fixture")
      expect(outcome.canonical?.total_return).toBeCloseTo(0.048, 2)
      expect(outcome.canonical?.total_trades).toBe(2)
      expect(outcome.cloudGates?.passed).toBe(true)
      expect(outcome.compositeVerdict).toBe("recommended_for_paper")
      expect(outcome.identity?.cloud.sourceTreeHash).toBeTruthy()
      expect(outcome.identity?.cloud.parameters.finny_runtime).toBe("lean_python")
    } finally {
      runSpy.mockRestore()
    }
  })
})
