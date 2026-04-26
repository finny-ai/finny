import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import {
  StrategyParams,
  parseConfig,
  mergeConfig,
  serializeConfig,
} from "../algorithm/strategy-params"

const parameters = z.object({
  name: z.string().describe("Saved algorithm name (kebab-case, matches finny_algorithm_save)"),
  params: StrategyParams.partial().describe(
    "Partial strategy parameters to merge into the algorithm's config. " +
      "Only include fields the user actually mentioned. " +
      "Use null in any field to clear it.",
  ),
})

const DESCRIPTION = [
  "Record execution-context parameters the user mentioned in chat onto a saved algorithm.",
  "",
  "Call this whenever the user states or revises one of:",
  "  - symbol  (e.g. 'UCO', 'BTC/USD')",
  "  - interval  (1min / 5min / 15min / 30min / 1h / 4h / 1d)",
  "  - equity_usd  (starting capital in USD)",
  "  - brokerage  (alpaca | binance)",
  "  - backtest.duration  ('2w', '4w', '5d', '1m', '1y', etc.)",
  "  - asset_class  (equity | crypto)",
  "",
  "Call eagerly — once per parameter as it surfaces. Pass only the fields you have a value for.",
  "Use null to clear a field. The tool merges into the existing config, so prior values stick.",
  "Do NOT record outputs (returns, P&L) — only inputs the user supplies.",
  "",
  "If no algorithm exists yet, scaffold + save one first via finny_algorithm_save, then call this.",
].join("\n")

export const AlgorithmSetParamsTool = Tool.define(
  "finny_algorithm_set_params",
  Effect.succeed({
    description: DESCRIPTION,
    parameters,
    execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> => {
        await ctx.ask({
          permission: "finny_algorithm_set_params",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const algo = await Algorithm.get(input.name)
        if (!algo) {
          return {
            title: "Algorithm not found",
            output: `No algorithm named "${input.name}". Save one first via finny_algorithm_save.`,
            metadata: { found: false },
          }
        }

        const prev = parseConfig(algo.config)
        const merged = mergeConfig(prev, input.params)
        const serialized = serializeConfig(merged)

        const updated = await Algorithm.updateConfig(algo.algorithmId, serialized)
        if (!updated) {
          return {
            title: "Update failed",
            output: `Could not update config for "${input.name}".`,
            metadata: { found: false },
          }
        }

        return {
          title: `Updated params on ${algo.name}`,
          output: JSON.stringify(merged, null, 2),
          metadata: {
            found: true,
            algorithmId: algo.algorithmId,
            name: algo.name,
            params: merged,
          },
        }
      }),
  }),
)
