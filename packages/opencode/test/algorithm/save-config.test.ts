import { afterEach, describe, expect, test } from "bun:test"
import { Algorithm } from "../../src/algorithm"
import { normalizeConfigForSave } from "../../src/algorithm/strategy-params"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("algorithm save config normalization", () => {
  test("moves top-level strategy params under params", () => {
    const normalized = normalizeConfigForSave({
      incoming: JSON.stringify({
        symbol: "QQQ",
        interval: "1d",
        equity_usd: 10000,
        fast_ma: 10,
        slow_ma: 30,
        profit_target: 0.1,
      }),
    })

    expect(JSON.parse(normalized!)).toEqual({
      symbol: "QQQ",
      interval: "1d",
      equity_usd: 10000,
      params: {
        fast_ma: 10,
        slow_ma: 30,
        profit_target: 0.1,
      },
    })
  })

  test("version save preserves execution config while replacing strategy params", () => {
    const normalized = normalizeConfigForSave({
      previous: JSON.stringify({
        symbol: "SPY",
        interval: "1d",
        equity_usd: 10000,
        asset_class: "equity",
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
      equity_usd: 10000,
      asset_class: "equity",
      params: {
        fast_ma: 20,
        slow_ma: 50,
        stop_loss: 0.06,
      },
    })
  })

  test("Algorithm.save preserves execution config on version bump", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Algorithm.save({
          name: "qqq-cross",
          code: "class Strategy:\n    pass\n",
          saveMode: "new",
          config: JSON.stringify({ symbol: "QQQ", interval: "1d", equity_usd: 10000, fast_ma: 10 }),
        })

        const saved = await Algorithm.save({
          name: "qqq-cross",
          code: "class Strategy:\n    pass\n",
          saveMode: "version",
          config: JSON.stringify({ fast_ma: 20, slow_ma: 50 }),
        })

        expect(JSON.parse(saved.config!)).toEqual({
          symbol: "QQQ",
          interval: "1d",
          equity_usd: 10000,
          params: { fast_ma: 20, slow_ma: 50 },
        })
      },
    })
  })
})
