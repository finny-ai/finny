import { afterEach, describe, expect, test } from "bun:test"
import { Algorithm } from "../../src/algorithm"
import {
  StrategyParams,
  missingRequiredNewSaveConfigFields,
  normalizeConfigForSave,
  parseConfig,
  unsupportedNewSaveConfigReasons,
} from "../../src/algorithm/strategy-params"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

describe("algorithm save config normalization", () => {
  test("moves top-level strategy params under params", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "QQQ",
        interval: "1d",
        required_history_bars: 50,
        equity_usd: 10000,
        fast_ma: 10,
        slow_ma: 30,
        profit_target: 0.1,
      }),
    })

    expect(JSON.parse(normalized!)).toEqual({
      symbol: "QQQ",
      interval: "1d",
      required_history_bars: 50,
      equity_usd: 10000,
      params: {
        fast_ma: 10,
        slow_ma: 30,
        profit_target: 0.1,
      },
    })
  })

  test("accepts ibkr brokerage in saved execution config", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "SPY",
        asset_class: "equity",
        interval: "15min",
        required_history_bars: 20,
        brokerage: "ibkr",
        params: { period: 20 },
      }),
    })

    expect(StrategyParams.safeParse(JSON.parse(normalized!)).success).toBe(true)
    expect(parseConfig(normalized).brokerage).toBe("ibkr")
  })

  test("normalizes broker-native crypto dot symbols before save", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "BTC.USD",
        asset_class: "crypto",
        interval: "15min",
        required_history_bars: 20,
        params: { period: 20 },
      }),
    })

    expect(parseConfig(normalized).symbol).toBe("BTC/USD")
  })

  test("reports missing new-save execution config fields", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "SPY",
        params: {},
      }),
    })

    expect(missingRequiredNewSaveConfigFields(normalized)).toEqual(["asset_class", "interval", "required_history_bars", "params"])
  })

  test("complete new-save execution config clears required-field blocker", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "SPY",
        asset_class: "equity",
        interval: "15min",
        required_history_bars: 20,
        params: { period: 20, risk_pct: 0.02 },
      }),
    })

    expect(missingRequiredNewSaveConfigFields(normalized)).toEqual([])
  })

  test("new-save execution config rejects comma-separated portfolio symbols", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "DELL, INTC, NVDA",
        asset_class: "equity",
        interval: "1d",
        required_history_bars: 20,
        params: { period: 20 },
      }),
    })

    expect(unsupportedNewSaveConfigReasons(normalized)).toEqual([
      "symbol must be one tradable symbol, not a comma-separated portfolio; use finny_portfolio_backtest or save one complete strategy per symbol",
    ])
  })

  test("version save preserves execution config while replacing strategy params", () => {
    const riskContract = {
      sizing_stop_distance_pct: 2,
      protective_stop: { mode: "strategy_next_open" },
      drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 10 },
      max_positions: 1,
    }
    const normalized = normalizeConfigForSave({
      previous: JSON.stringify({
        symbol: "SPY",
        interval: "1d",
        required_history_bars: 50,
        equity_usd: 10000,
        asset_class: "equity",
        risk_contract: riskContract,
        params: { old_param: 1 },
      }),
      incoming: JSON.stringify({
        fast_ma: 20,
        slow_ma: 50,
        stop_loss: 0.06,
      }),
      preserveExecution: true,
    })

    expect(JSON.parse(normalized!)).toEqual({
      symbol: "SPY",
      interval: "1d",
      required_history_bars: 50,
      equity_usd: 10000,
      asset_class: "equity",
      risk_contract: riskContract,
      params: {
        fast_ma: 20,
        slow_ma: 50,
        stop_loss: 0.06,
      },
    })
  })

  test("Algorithm.save preserves execution config on version bump", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await Algorithm.save({
          name: "qqq-cross",
          code: "class Strategy:\n    pass\n",
          saveMode: "new",
          config: JSON.stringify({ symbol: "QQQ", interval: "1d", required_history_bars: 50, equity_usd: 10000, fast_ma: 10 }),
        })

        const saved = await Algorithm.save({
          name: "qqq-cross",
          code: "class Strategy:\n    pass\n",
          saveMode: "version",
          docsMode: "inherit",
          config: JSON.stringify({ fast_ma: 20, slow_ma: 50 }),
        })

        expect(JSON.parse(saved.config!)).toEqual({
          symbol: "QQQ",
          interval: "1d",
          required_history_bars: 50,
          equity_usd: 10000,
          params: { fast_ma: 20, slow_ma: 50 },
        })
      },
    })
  })

  test("version saves require an explicit docsMode", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await Algorithm.save({
          name: "spy-doc-mode",
          code: "class Strategy:\n    pass\n",
          saveMode: "new",
          config: JSON.stringify({ symbol: "SPY", interval: "1d", required_history_bars: 20 }),
        })

        await expect(
          Algorithm.save({
            name: "spy-doc-mode",
            code: "class Strategy:\n    version = 2\n",
            saveMode: "version",
          }),
        ).rejects.toBeInstanceOf(Algorithm.DocsModeRequiredError)
      },
    })
  })

  test("config updates create a new immutable version and inherit documents", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const first = await Algorithm.save({
          name: "spy-versioned-params",
          code: "class Strategy:\n    pass\n",
          saveMode: "new",
          config: JSON.stringify({ symbol: "SPY", interval: "1d", required_history_bars: 20, params: { period: 10 } }),
          mission: "mission-v1\n",
          prefs: "prefs-v1\n",
          decisions: "decision-v1\n",
          riskContract: '{"max_drawdown_pct":10}\n',
        })

        const updated = await Algorithm.updateConfig(
          first.algorithmId,
          JSON.stringify({ symbol: "SPY", interval: "1d", required_history_bars: 20, params: { period: 20 } }),
        )
        expect(updated?.version).toBe(2)

        const old = await Algorithm.getVersion(first.algorithmId, 1)
        expect(JSON.parse(old!.config!).params.period).toBe(10)
        expect(JSON.parse(updated!.config!).params.period).toBe(20)
        expect(updated?.mission).toBe("mission-v1\n")
        expect(updated?.prefs).toBe("prefs-v1\n")
        expect(updated?.decisions).toBe("decision-v1\n")
        expect(updated?.riskContract).toBe('{"max_drawdown_pct":10}\n')
      },
    })
  })
})
