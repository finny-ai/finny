import { describe, expect, test } from "bun:test"
import { LiveRunner } from "../../src/live/runner"

describe("LiveRunner eligibility gate", () => {
  test("paper and testnet require an exact approved run", () => {
    expect(LiveRunner.canStartForMode("backtested", "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("robustness_passed", "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("paper_eligible", "paper")).toBe(true)
    expect(LiveRunner.canStartForMode("paper_eligible", "testnet")).toBe(true)
  })

  test("requires robustness for live-money runs", () => {
    expect(LiveRunner.canStartForMode("backtested", "live")).toBe(false)
    expect(LiveRunner.canStartForMode("robustness_passed", "live")).toBe(false)
    expect(LiveRunner.canStartForMode("paper_eligible", "live")).toBe(false)
    expect(LiveRunner.canStartForMode("live_eligible", "live")).toBe(true)
  })

  test("blocks paper when no completed backtest exists", () => {
    expect(LiveRunner.canStartForMode(null, "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("validated", "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("prototype", "paper")).toBe(false)
  })

  test("only terminal live runs can be removed", () => {
    expect(LiveRunner.canRemoveStatus("starting")).toBe(false)
    expect(LiveRunner.canRemoveStatus("running")).toBe(false)
    expect(LiveRunner.canRemoveStatus("stopped")).toBe(true)
    expect(LiveRunner.canRemoveStatus("error")).toBe(true)
  })
})

describe("LiveRunner multi-market start target", () => {
  test("normalizes supported markets for Alpaca, Binance, IBKR, and Robinhood", () => {
    expect(
      LiveRunner.resolveStartTarget({
        symbol: "aapl",
        accountProviderID: "alpaca-paper-equities",
      }),
    ).toEqual({ brokerKind: "alpaca", symbol: "AAPL" })

    expect(
      LiveRunner.resolveStartTarget({
        symbol: "BTC/USD",
        accountProviderID: "binance-testnet-crypto",
      }),
    ).toEqual({ brokerKind: "binance", symbol: "BTC/USDT" })

    expect(
      LiveRunner.resolveStartTarget({
        symbol: "ES/CONT",
        accountProviderID: "ibkr-futures",
      }),
    ).toEqual({ brokerKind: "ibkr", symbol: "ES/CONT" })

    expect(
      LiveRunner.resolveStartTarget({
        symbol: "SPY/20260619/500C",
        accountProviderID: "ibkr-options",
      }),
    ).toEqual({ brokerKind: "ibkr", symbol: "SPY/20260619/500C" })

    expect(
      LiveRunner.resolveStartTarget({
        symbol: "BTC/USD",
        accountProviderID: "robinhood-rhx-primary",
      }),
    ).toEqual({ brokerKind: "robinhood", symbol: "BTC-USD" })
  })

  test("rejects a broker/account mismatch before reading credentials", () => {
    expect(() =>
      LiveRunner.resolveStartTarget({
        symbol: "BTC/USD",
        accountProviderID: "alpaca-paper-crypto",
        brokerKind: "binance",
      }),
    ).toThrow("belongs to Alpaca")
  })

  test("rejects a market the selected brokerage cannot execute", () => {
    expect(() =>
      LiveRunner.resolveStartTarget({
        symbol: "AAPL",
        accountProviderID: "binance-testnet-crypto",
      }),
    ).toThrow('Symbol "AAPL" is not compatible with Binance')
  })
})

describe("LiveRunner multi-market deployment key", () => {
  const activeRun: LiveRunner.Run = {
    id: "run_1",
    backtestRunId: "backtest_1",
    algorithmId: "algo_1",
    algorithmName: "Cross-market strategy",
    symbol: "BTC/USDT",
    interval: "1min",
    brokerKind: "binance",
    accountProviderID: "binance-testnet-crypto",
    mode: "testnet",
    directory: "/project-a",
    status: "running",
    startedAt: 1,
    positions: {},
    orders: [],
    logs: [],
    shadowProof: {
      finalizedDecisionBars: 0,
      sessionIds: [],
      reconciliationDivergences: 0,
      fatalErrors: 0,
    },
  }

  test("rejects only the exact active deployment", () => {
    expect(
      LiveRunner.isActiveDeploymentConflict(activeRun, {
        algorithmId: "algo_1",
        accountProviderID: "binance-testnet-crypto",
        symbol: "btc/usdt",
      }),
    ).toBe(true)
  })

  test("allows distinct markets and accounts to run concurrently", () => {
    expect(
      LiveRunner.isActiveDeploymentConflict(activeRun, {
        algorithmId: "algo_1",
        accountProviderID: "binance-testnet-crypto",
        symbol: "ETH/USDT",
      }),
    ).toBe(false)
    expect(
      LiveRunner.isActiveDeploymentConflict(activeRun, {
        algorithmId: "algo_1",
        accountProviderID: "binance-live-crypto",
        symbol: "BTC/USDT",
      }),
    ).toBe(false)
    expect(
      LiveRunner.isActiveDeploymentConflict(activeRun, {
        algorithmId: "algo_1",
        accountProviderID: "binance-testnet-crypto",
        symbol: "BTC/USDT",
      }),
    ).toBe(true)
  })

  test("allows a stopped deployment to restart", () => {
    expect(
      LiveRunner.isActiveDeploymentConflict(
        { ...activeRun, status: "stopped" },
        {
          algorithmId: "algo_1",
          accountProviderID: "binance-testnet-crypto",
          symbol: "BTC/USDT",
        },
      ),
    ).toBe(false)
  })
})
