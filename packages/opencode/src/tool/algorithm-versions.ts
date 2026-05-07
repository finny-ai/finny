import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"

const parameters = z
  .object({
    name: z.string().optional().describe("The algorithm name (preferred). Resolves to its lineage and lists all versions."),
    algorithmId: z.string().optional().describe("Alternative: the lineage UUID. Use when the name is ambiguous or you already have the id."),
  })
  .refine((v) => !!v.name || !!v.algorithmId, {
    message: "Provide either name or algorithmId.",
  })

// Brief paramSummary: pull a small slice of common config keys so the model
// can describe each version without having to call algorithm-get on each.
function paramSummary(configJson: string | undefined): Record<string, unknown> | undefined {
  if (!configJson) return undefined
  try {
    const obj = JSON.parse(configJson)
    if (!obj || typeof obj !== "object") return undefined
    const keys = ["symbol", "interval", "risk_pct", "stop_pct", "tp_pct", "fast_period", "slow_period", "rsi_period"]
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in obj) out[k] = obj[k]
    return Object.keys(out).length ? out : undefined
  } catch {
    return undefined
  }
}

export const AlgorithmVersionsTool = Tool.define(
  "finny_algorithm_versions",
  Effect.succeed({
    description:
      "List every saved version of an algorithm, newest first. Use this BEFORE telling the user what versions exist, BEFORE choosing whether to bump or fork, and to find the version number to pass to finny_algorithm_export.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        await ctx.ask({
          permission: "finny_algorithm_versions",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        // Resolve algorithmId from name if not provided.
        let algorithmId = params.algorithmId
        let resolvedName: string | undefined
        if (!algorithmId && params.name) {
          const latest = await Algorithm.get(params.name)
          if (!latest) {
            return {
              title: "Not found",
              output: `No algorithm found with name "${params.name}". Use finny_algorithm_list to see available algorithms.`,
              metadata: { found: false },
            }
          }
          algorithmId = latest.algorithmId
          resolvedName = latest.name
        }
        if (!algorithmId) {
          return {
            title: "Bad input",
            output: "Provide either name or algorithmId.",
            metadata: { found: false },
          }
        }

        const versions = await Algorithm.listVersions(algorithmId)
        if (versions.length === 0) {
          return {
            title: "No versions",
            output: `No versions found for algorithmId ${algorithmId}.`,
            metadata: { found: false, algorithmId },
          }
        }

        const name = resolvedName ?? versions[0].name
        const summary = versions.map((v) => ({
          version: v.version,
          status: v.status,
          description: v.description ?? "",
          createdAt: new Date(v.time_created).toISOString(),
          updatedAt: new Date(v.time_updated).toISOString(),
          params: paramSummary(v.config),
        }))

        return {
          title: `${name} — ${versions.length} version${versions.length === 1 ? "" : "s"}`,
          output: JSON.stringify({ algorithmId, name, versions: summary }, null, 2),
          metadata: { found: true, algorithmId, count: versions.length },
        }
      }),
  }),
)
