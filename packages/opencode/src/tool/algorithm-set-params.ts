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
  "Record non-identity runtime parameters the user mentioned in chat onto a saved algorithm.",
  "",
  "Call this only when the user states or revises one of:",
  "  - equity_usd  (starting capital in USD)",
  "  - backtest.duration  ('2w', '4w', '5d', '1m', '1y', etc.)",
  "  - strategy params under params",
  "",
  "Do not change execution identity fields here: symbol, asset_class, interval, required_history_bars, or brokerage.",
  "If one of those changes, save a new version with complete config and matching code/name instead.",
  "Call eagerly for allowed fields only — once per parameter as it surfaces. Pass only fields you have a value for.",
  "Use null to clear a field. The tool merges into the existing config, so prior values stick.",
  "Do NOT record outputs (returns, P&L) — only inputs the user supplies.",
  "",
  "If no algorithm exists yet, save one with complete config via finny_algorithm_save; do not save first and patch missing config here.",
].join("\n")

const IDENTITY_KEYS = ["symbol", "asset_class", "interval", "required_history_bars", "brokerage"] as const

export function blockedIdentityParamKeys(params: Partial<StrategyParams>): string[] {
  return IDENTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(params, key))
}

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

        const blockedKeys = blockedIdentityParamKeys(input.params)
        if (blockedKeys.length > 0) {
          return {
            title: "Param update blocked",
            output:
              `Refusing to patch execution identity on "${input.name}": ${blockedKeys.join(", ")}.\n\n` +
              "Save a new version with complete config, matching code/name, and validation instead.",
            metadata: { found: true, blocked: true, blockedKeys },
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
