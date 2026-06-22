import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BacktestRunner } from "../../src/backtest/runner"

const { parseResults } = BacktestRunner._internalForTests

// Minimal valid stdout — just the keys parseResults requires.
function minimal(extra = ""): string {
  return [
    "total_return: 0.123456",
    "max_drawdown: 0.050000",
    "ann_vol: 0.20",
    "ann_sharpe: 1.5",
    "ending_equity: 11234.50",
    "total_trades: 10",
    "win_rate: 0.6",
    "profit_factor: 2.0",
    "low_sample: 0",
    "sortino: 1.8",
    "calmar: 3.0",
    "var_95: 0.015",
    "cvar_95: 0.025",
    "max_dd_duration: 12",
    "time_in_market: 0.5",
    "diag_bars_processed: 100",
    "diag_buy_attempts: 5",
    "diag_sell_attempts: 5",
    "diag_rejected_orders: 0",
    "diag_pending_orders_at_end: 0",
    'diag_rejection_reasons: {}',
    "diag_price_first: 100.0",
    "diag_price_last: 110.0",
    "diag_price_range_pct: 0.10",
    "diag_strategy_errors: 0",
    "diag_participation_warning_count: 0",
    'diag_assumptions: {"fee_rate":0.00075,"slippage":0.0001,"fill_model":"next_open","participation_cap_pct":10.0}',
    "engine_version: engine.next-open-v1",
    "backtest_schema_version: 3",
    extra,
  ].filter(Boolean).join("\n")
}

describe("parseResults", () => {
  test("parses minimal valid output", async () => {
    const r = await parseResults(minimal(), "")
    expect(r).not.toBeNull()
    expect(r!.totalReturn).toBeCloseTo(0.123456)
    expect(r!.sharpeRatio).toBeCloseTo(1.5)
    expect(r!.endingEquity).toBeCloseTo(11234.5)
    expect(r!.engineVersion).toBe("engine.next-open-v1")
    expect(r!.schemaVersion).toBe(3)
  })

  test("surfaces NaN as parse_warning and does not store as metric", async () => {
    const stdout = minimal().replace("ann_sharpe: 1.5", "ann_sharpe: nan")
    const r = await parseResults(stdout, "")
    expect(r).not.toBeNull()
    expect(Number.isNaN(r!.sharpeRatio)).toBe(true)
    expect(r!.diagnostics?.parseWarnings).toBeDefined()
    expect(r!.diagnostics!.parseWarnings!.some(w => w.startsWith("ann_sharpe"))).toBe(true)
  })

  test("surfaces Infinity as parse_warning", async () => {
    const stdout = minimal().replace("profit_factor: 2.0", "profit_factor: inf")
    const r = await parseResults(stdout, "")
    expect(r!.profitFactor).toBeNull()
    expect(r!.diagnostics?.parseWarnings).toBeDefined()
    expect(r!.diagnostics!.parseWarnings!.some(w => w.startsWith("profit_factor"))).toBe(true)
  })

  test("parses assumptions block", async () => {
    const r = await parseResults(minimal(), "")
    expect(r!.diagnostics?.assumptions).toBeDefined()
    expect(r!.diagnostics!.assumptions!.fill_model).toBe("next_open")
    expect(r!.diagnostics!.assumptions!.fee_rate).toBeCloseTo(0.00075)
    expect(r!.diagnostics!.assumptions!.participation_cap_pct).toBeCloseTo(10.0)
  })

  test("parses kill switch trip", async () => {
    const stdout = minimal('diag_killed: {"reason":"drawdown","equity":-500,"threshold":2000,"drawdown_frac":0.8}')
    const r = await parseResults(stdout, "")
    expect(r!.diagnostics?.killed).toBeDefined()
    expect(r!.diagnostics!.killed!.reason).toBe("drawdown")
  })

  test("parses pending orders at end of window", async () => {
    const stdout = minimal().replace("diag_pending_orders_at_end: 0", "diag_pending_orders_at_end: 3")
    const r = await parseResults(stdout, "")
    expect(r!.diagnostics?.pendingOrdersAtEnd).toBe(3)
  })

  test("populates v2 stub when stability_json is present", async () => {
    const stab = JSON.stringify({
      equity_curve_r2: 0.85, rolling_sharpe_window: 30,
      rolling_sharpe_mean: 1.2, rolling_sharpe_min: -0.5,
      monthly_returns: { "2026": { "01": 0.03, "02": -0.01 } },
    })
    const stdout = minimal(`stability_json: ${stab}`)
    const r = await parseResults(stdout, "")
    expect(r!.v2).toBeDefined()
    expect(r!.v2!.stability).toBeDefined()
    expect(r!.v2!.stability.equity_curve_r2).toBeCloseTo(0.85)
  })

  test("populates v2.regimes when regimes_json is present", async () => {
    const regs = JSON.stringify([
      { regime: "low_vol", n_bars: 30, pct_of_window: 0.33, total_return: 0.01, sharpe: 0.5, max_drawdown: 0.02, n_trades: 0, win_rate: 0.5 },
    ])
    const stdout = minimal(`regimes_json: ${regs}`)
    const r = await parseResults(stdout, "")
    expect(r!.v2?.regimes).toBeDefined()
    expect(r!.v2!.regimes![0].regime).toBe("low_vol")
  })

  test("returns null when ending_equity is missing", async () => {
    const r = await parseResults("total_return: 0.1\nmax_drawdown: 0.01\n", "")
    expect(r).toBeNull()
  })

  test("schema_version 2 still parses (back-compat with legacy stdout)", async () => {
    const stdout = minimal()
      .replace("backtest_schema_version: 3", "backtest_schema_version: 2")
      .replace("engine_version: engine.next-open-v1", "")
    const r = await parseResults(stdout, "")
    expect(r).not.toBeNull()
    expect(r!.schemaVersion).toBe(2)
  })

  test("normalizes v2 signed drawdown and exposure fraction for legacy consumers", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "finny-parse-results-"))
    try {
      await fs.writeFile(path.join(tmp, "results.json"), JSON.stringify({
        schema_version: "3.0.0",
        engine_version: "engine_v2-test",
        seed: 123,
        starting_equity: 10000,
        ending_equity: 9500,
        bars_processed: 20,
        interval: "1h",
        start_ts: "2026-01-01 00:00:00+00:00",
        end_ts: "2026-01-02 00:00:00+00:00",
        symbols: ["BTC/USD"],
        total_return: -0.05,
        max_drawdown: -0.1234,
        ann_vol: 0.2,
        ann_sharpe: -1.1,
        total_trades: 2,
        win_rate: 0.5,
        profit_factor: 0.8,
        returns: {},
        risk: {},
        ratios: {},
        drawdown: {},
        trade: {},
        exposure: { time_in_market_pct: 0.625, liquidation_count: 0, max_gross_exposure: 2500 },
        stability: {},
        trades: [],
        per_symbol: [],
        data_quality: {},
        product_label: "Crucible 2.0",
        run_kind: "crucible_2_0",
        nav_summary: {
          mark_to_market_nav: 9500,
          liquidation_nav: 9400,
          explanation: "nav",
        },
        cost_attribution: {
          total_costs: 12,
          fees: 10,
          funding: 2,
          borrow: 0,
          cost_as_pct_starting_equity: 0.0012,
          explanation: "costs",
        },
        profile_identity: {
          product_label: "Crucible 2.0",
          profile_id: "engine:test",
          strategy_hash: "abc",
          config_hash: "def",
          data_hash: "ghi",
          explanation: "profile",
        },
        sensitivity_outcomes: [
          { name: "Monte Carlo", status: "pass", value: 0.4, explanation: "mc" },
        ],
        explanations: {
          product: "product",
          mark_to_market_nav: "mtm",
          liquidation_nav: "liq",
          cost_attribution: "cost",
          profile_identity: "profile",
          sensitivity_outcomes: "sens",
        },
        benchmark: null,
        monte_carlo: null,
        walk_forward: null,
        regimes: null,
        execution_config: { fill_model: "engine_v2.next_open", participation_pct: 0.1 },
      }))

      const r = await parseResults("", tmp)
      expect(r).not.toBeNull()
      expect(r!.maxDrawdown).toBeCloseTo(0.1234)
      expect(r!.timeInMarket).toBeCloseTo(0.625)
      expect(r!.productLabel).toBe("Crucible 2.0")
      expect(r!.runKind).toBe("crucible_2_0")
      expect(r!.navSummary?.mark_to_market_nav).toBe(9500)
      expect(r!.costAttribution?.total_costs).toBe(12)
      expect(r!.profileIdentity?.profile_id).toBe("engine:test")
      expect(r!.sensitivityOutcomes?.[0]?.name).toBe("Monte Carlo")
      expect(r!.explanations?.liquidation_nav).toBe("liq")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("accepts nullable v2 profit factor and omega without fake zero substitution", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "finny-parse-results-null-metrics-"))
    try {
      await fs.writeFile(path.join(tmp, "results.json"), JSON.stringify({
        schema_version: "3.0.0",
        engine_version: "engine_v2-test",
        seed: 123,
        starting_equity: 10000,
        ending_equity: 10100,
        bars_processed: 20,
        interval: "1d",
        start_ts: "2026-01-01 00:00:00+00:00",
        end_ts: "2026-01-20 00:00:00+00:00",
        symbols: ["AAPL"],
        total_return: 0.01,
        max_drawdown: 0,
        ann_vol: 0,
        ann_sharpe: 0,
        total_trades: 1,
        win_rate: 1,
        profit_factor: null,
        returns: {},
        risk: {},
        ratios: { omega: null },
        drawdown: {},
        trade: { profit_factor: null },
        exposure: { time_in_market_pct: 0.5, liquidation_count: 0, max_gross_exposure: 100 },
        stability: {},
        trades: [],
        per_symbol: [],
        data_quality: {},
        diagnostics: {
          non_finite_metrics: [{ path: "trade.profit_factor", value: "inf" }],
        },
      }))

      const r = await parseResults("", tmp)
      expect(r).not.toBeNull()
      expect(r!.profitFactor).toBeNull()
      expect(r!.v2!.profit_factor).toBeNull()
      expect(r!.v2!.ratios.omega).toBeNull()
      expect((r!.v2!.diagnostics as any).non_finite_metrics[0].path).toBe("trade.profit_factor")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
