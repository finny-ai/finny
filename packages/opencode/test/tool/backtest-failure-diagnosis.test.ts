import { describe, expect, test } from "bun:test"
import { evaluateBacktestQuality } from "../../src/backtest/evaluation"
import type { BacktestRunner } from "../../src/backtest/runner"
import {
  analyzeStrategyCodePatterns,
  classifyCompletedBacktestFailure,
  classifyConceptExhaustedFailure,
  classifyDataBlockedFailure,
  classifyEngineFailedFailure,
  classifyValidationFailedFailure,
  priorBacktestsHadMetrics,
} from "../../src/tool/backtest-failure-diagnosis"

function result(overrides: Partial<BacktestRunner.Results>): BacktestRunner.Results {
  return {
    totalReturn: -0.12,
    maxDrawdown: 0.18,
    annualizedVolatility: 0.25,
    sharpeRatio: -0.4,
    endingEquity: 8800,
    totalTrades: 8,
    winRate: 0.375,
    profitFactor: 0.7,
    diagnostics: {
      barsProcessed: 180,
      buyAttempts: 8,
      sellAttempts: 8,
      rejectedOrders: 0,
      rejectionReasons: {},
      priceFirst: 42000,
      priceLast: 51000,
      priceRangePct: 0.21,
      strategyErrors: 0,
    },
    ...overrides,
  }
}

function diagnostics(overrides: Partial<NonNullable<BacktestRunner.Results["diagnostics"]>>) {
  return {
    barsProcessed: 180,
    buyAttempts: 0,
    sellAttempts: 0,
    rejectedOrders: 0,
    rejectionReasons: {},
    priceFirst: 42000,
    priceLast: 51000,
    priceRangePct: 0.21,
    strategyErrors: 0,
    ...overrides,
  }
}

function diagnoseCryptoDaily(code: string, overrides: Partial<BacktestRunner.Results>) {
  const results = result(overrides)
  return classifyCompletedBacktestFailure({
    results,
    quality: evaluateBacktestQuality(results),
    code,
    assetClass: "crypto",
    interval: "1d",
  })
}

describe("failure classification", () => {
  test("negative ROI with trades => strategy_loss", () => {
    const r = result({ totalTrades: 12, totalReturn: -0.08, sharpeRatio: -0.2 })
    const quality = evaluateBacktestQuality(r)
    const diagnosis = classifyCompletedBacktestFailure({ results: r, quality })
    expect(diagnosis?.classification).toBe("strategy_loss")
    expect(diagnosis?.engineRan).toBe(true)
    expect(diagnosis?.likelyCause).toBe("concept")
    expect(diagnosis?.summary).toContain("entered trades but lost money")
  })

  test("zero trades with no buy attempts => entry_never_triggered", () => {
    const diagnosis = diagnoseCryptoDaily("", {
      totalTrades: 0,
      totalReturn: 0,
      sharpeRatio: 0,
      diagnostics: diagnostics({}),
    })
    expect(diagnosis?.classification).toBe("zero_trades")
    expect(diagnosis?.subreason).toBe("entry_never_triggered")
  })

  test("rejected orders from insufficient margin => sizing_failure", () => {
    const diagnosis = diagnoseCryptoDaily("", {
      totalTrades: 0,
      totalReturn: 0,
      sharpeRatio: 0,
      diagnostics: diagnostics({
        buyAttempts: 4,
        sellAttempts: 3,
        rejectedOrders: 7,
        rejectionReasons: { insufficient_margin: 7 },
        priceFirst: 60000,
        priceLast: 65000,
        priceRangePct: 0.08,
      }),
    })
    expect(diagnosis?.classification).toBe("sizing_failure")
    expect(diagnosis?.likelyCause).toBe("strategy_code")
  })

  test("data-quality blocked output => data_blocked", () => {
    const diagnosis = classifyDataBlockedFailure("Data quality failed before resample")
    expect(diagnosis.classification).toBe("data_blocked")
    expect(diagnosis.engineRan).toBe(false)
    expect(diagnosis.likelyCause).toBe("backtest_data")
  })

  test("strict engine exception => engine_failed", () => {
    const diagnosis = classifyEngineFailedFailure("Strict engine failed: symbol not found")
    expect(diagnosis.classification).toBe("engine_failed")
    expect(diagnosis.engineRan).toBe(false)
  })

  test("validation failure => validation_failed", () => {
    const diagnosis = classifyValidationFailedFailure()
    expect(diagnosis.classification).toBe("validation_failed")
    expect(diagnosis.engineRan).toBe(false)
  })

  test("concept exhaustion with prior metrics => engine success wording", () => {
    const diagnosis = classifyConceptExhaustedFailure({
      consecutiveFailures: 5,
      algorithmName: "btc-daily-rsi-v5",
      priorRunsHadMetrics: true,
    })
    expect(diagnosis.classification).toBe("concept_exhausted")
    expect(diagnosis.summary).toContain("Backtest engine ran successfully")
    expect(diagnosis.likelyCause).toBe("concept")
  })
})

describe("code pattern preflight", () => {
  test("crypto code with int(qty) => sizing warning", () => {
    const code = `
class Strategy:
    def on_bar(self, symbol, bar):
        qty = int(self.broker.equity * 0.1 / bar["open"])
        self.broker.buy(symbol, qty)
`
    const warnings = analyzeStrategyCodePatterns(code, { assetClass: "crypto", interval: "1d" })
    expect(warnings.some((w) => w.includes("int(qty)"))).toBe(true)
  })

  test("crypto code with max(1, ...) => sizing warning", () => {
    const warnings = analyzeStrategyCodePatterns(
      `qty = max(1, int(qty))`,
      { assetClass: "crypto", interval: "1d" },
    )
    expect(warnings.some((w) => w.includes("max(1"))).toBe(true)
  })
})

describe("BTC daily regression scenario", () => {
  test("early int(qty) variants diagnose as sizing/code risk", () => {
    const code = `
class Strategy:
    def on_bar(self, symbol, bar):
        qty = max(1, int(self.broker.equity * 0.1 / bar["open"]))
        self.broker.buy(symbol, qty)
`
    const diagnosis = diagnoseCryptoDaily(code, {
      totalTrades: 0,
      totalReturn: 0,
      sharpeRatio: 0,
      diagnostics: diagnostics({
        barsProcessed: 90,
        buyAttempts: 4,
        sellAttempts: 3,
        rejectedOrders: 7,
        rejectionReasons: { insufficient_margin: 7 },
        priceFirst: 60000,
        priceLast: 68000,
        priceRangePct: 0.13,
      }),
    })
    expect(diagnosis?.classification).toBe("sizing_failure")
    expect(diagnosis?.codePatternWarnings?.some((w) => w.includes("int(qty)"))).toBe(true)
  })

  test("later traded variants with negative return => strategy_loss", () => {
    const code = `
class Strategy:
    def on_bar(self, symbol, bar):
        qty = round(self.broker.equity * 0.1 / bar["open"], 6)
        if rsi < 30:
            self.broker.buy(symbol, qty)
`
    const diagnosis = diagnoseCryptoDaily(code, {
      totalTrades: 14,
      totalReturn: -0.09,
      sharpeRatio: -0.55,
      winRate: 0.36,
      diagnostics: diagnostics({
        barsProcessed: 90,
        buyAttempts: 14,
        sellAttempts: 14,
        rejectedOrders: 0,
        rejectionReasons: {},
        priceFirst: 60000,
        priceLast: 68000,
        priceRangePct: 0.13,
      }),
    })
    expect(diagnosis?.classification).toBe("strategy_loss")
    expect(diagnosis?.engineRan).toBe(true)
  })

  test("final stop message distinguishes engine success from blockers", () => {
    const exhausted = classifyConceptExhaustedFailure({
      consecutiveFailures: 5,
      algorithmName: "btc-daily-rsi-v5",
      priorRunsHadMetrics: true,
    })
    expect(exhausted.summary).toContain("strategy variants lost money")
    expect(exhausted.guidance.join(" ")).toContain("not backtest/data when metrics were produced")

    const blocked = classifyConceptExhaustedFailure({
      consecutiveFailures: 5,
      algorithmName: "btc-daily-rsi-v5",
      priorRunsHadMetrics: false,
    })
    expect(blocked.summary).toContain("Backtest did not run")
  })
})

describe("priorBacktestsHadMetrics", () => {
  test("detects prior completed runs with metrics in metadata or output", () => {
    const messages = [
      {
        parts: [
          {
            type: "tool",
            tool: "finny_backtest",
            state: {
              status: "completed",
              input: { algorithmName: "btc-daily-rsi-v1" },
              output: "Verdict: failed",
              metadata: { results: { totalReturn: -0.1 } },
            },
          },
        ],
      },
    ]
    expect(priorBacktestsHadMetrics(messages)).toBe(true)
  })
})
