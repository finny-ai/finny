import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { parseConfig } from "../algorithm/strategy-params"
import { AlpacaData } from "../cron/alpaca-data"
import { BacktestStore } from "../backtest/store"

async function latestBacktest(algorithm: Algorithm.Info | null): Promise<BacktestStore.Manifest | null> {
  if (!algorithm) return null
  const exact = await BacktestStore.list({ algorithmName: algorithm.name, algorithmId: algorithm.algorithmId, limit: 1 })
  if (exact[0]) return exact[0]
  const byId = await BacktestStore.list({ algorithmId: algorithm.algorithmId, limit: 1 })
  if (byId[0]) return byId[0]
  const legacyByName = await BacktestStore.list({ algorithmName: algorithm.name, limit: 10 })
  return legacyByName.find((entry) => !entry.algorithmId) ?? null
}

const parameters = z.object({
  algorithm: z
    .string()
    .optional()
    .describe("Saved algorithm name or algorithmId. Used to infer symbol, brokerage, and context."),
  symbol: z
    .string()
    .optional()
    .describe("Symbol or pair to inspect. Overrides the symbol stored on the algorithm config."),
  brokerage: z
    .enum(["alpaca", "binance"])
    .optional()
    .describe("Brokerage to inspect. Overrides the brokerage stored on the algorithm config."),
})

export const MonitorSnapshotTool = Tool.define(
  "finny_monitor_snapshot",
  Effect.succeed({
    description:
      "Get the current monitoring snapshot for a trading algorithm: saved algorithm info, inferred symbol/brokerage, latest Alpaca market/account state, open position size, and the latest matching backtest result when available. Use this as the first tool when monitoring deployed strategies.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await Effect.runPromise(
          ctx.ask({
            permission: "finny_monitor_snapshot",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          }),
        )

        const algorithm = params.algorithm ? await Algorithm.resolve(params.algorithm) : null
        const config = parseConfig(algorithm?.config)
        const symbol = params.symbol ?? config.symbol
        const brokerage = params.brokerage ?? config.brokerage
        const backtest = await latestBacktest(algorithm)

        const payload: Record<string, unknown> = {
          algorithm: algorithm
            ? {
                algorithmId: algorithm.algorithmId,
                name: algorithm.name,
                version: algorithm.version,
                status: algorithm.status,
                updated: new Date(algorithm.time_updated).toISOString(),
              }
            : null,
          config,
          symbol: symbol ?? null,
          brokerage: brokerage ?? null,
          liveSupport: brokerage === undefined || brokerage === "alpaca" ? "supported" : "unsupported",
          market: null,
          account: null,
          positionQty: null,
          latestBacktest: backtest
            ? {
                timestamp: new Date(backtest.timestamp).toISOString(),
                symbol: backtest.symbol ?? null,
                params: backtest.params,
                results: backtest.results,
                benchmark: backtest.benchmark,
                alpha: backtest.alpha,
                evidence: backtest.dir ?? null,
              }
            : null,
        }

        if (brokerage && brokerage !== "alpaca") {
          payload.warning = `Live monitoring is only wired for Alpaca in this first version. Requested brokerage: ${brokerage}.`
        } else {
          if (symbol) {
            payload.market = await AlpacaData.snapshot(symbol)
            payload.positionQty = await AlpacaData.position(symbol)
          }
          payload.account = await AlpacaData.account()
        }

        return {
          title: algorithm ? `Monitoring snapshot for ${algorithm.name}` : "Monitoring snapshot",
          output: JSON.stringify(payload, null, 2),
          metadata: {
            found: !!algorithm || !params.algorithm,
            symbol: symbol ?? null,
            brokerage: brokerage ?? null,
          },
        }
      }),
  }),
)
