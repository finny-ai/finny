import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { Plan } from "../plan"

const parameters = z.object({})

export type AlgorithmSummary = {
  name: string
  version: number
  status: string
  language: string
  description: string
  updated: string
}

export type AlgorithmListPayload = {
  count: number
  /** number of slots, or null when the tier is unlimited */
  capacity: number | null
  /** remaining slots, or null when the tier is unlimited */
  remaining: number | null
  tier: Plan.Tier
  algorithms: AlgorithmSummary[]
}

/**
 * Pure helper — exposed for testing. Collapses rows to one entry per unique
 * name (latest version wins) and reports cap usage in a JSON-safe shape:
 * `null` is used for both `capacity` and `remaining` when the tier has no
 * cap, so callers never have to deal with `Infinity` (which JSON.stringify
 * coerces to `null` anyway).
 */
export function buildAlgorithmListPayload(
  algos: ReadonlyArray<Algorithm.Info>,
  tier: Plan.Tier,
): AlgorithmListPayload {
  // Pick the "latest" row per name: highest version, with time_updated as
  // the tiebreaker so the choice is deterministic when duplicate-name rows
  // share a version (e.g., config-only updates that didn't bump version).
  const latestByName = new Map<string, Algorithm.Info>()
  for (const a of algos) {
    const prev = latestByName.get(a.name)
    if (
      !prev ||
      a.version > prev.version ||
      (a.version === prev.version && a.time_updated > prev.time_updated)
    ) {
      latestByName.set(a.name, a)
    }
  }
  const unique = Array.from(latestByName.values()).sort((a, b) => b.time_updated - a.time_updated)

  const rawCap = Plan.SAVE_CAP[tier]
  const capacity = Number.isFinite(rawCap) ? rawCap : null
  const remaining = capacity === null ? null : Math.max(0, capacity - unique.length)

  const algorithms: AlgorithmSummary[] = unique.map((a) => ({
    name: a.name,
    version: a.version,
    status: a.status,
    language: a.language,
    description: a.description ?? "",
    updated: new Date(a.time_updated).toISOString(),
  }))

  return { count: unique.length, capacity, remaining, tier, algorithms }
}

function buildTitle(p: AlgorithmListPayload): string {
  if (p.count === 0) return `No algorithms (${p.tier} tier)`
  const slotPart = p.capacity === null ? "" : `, ${p.remaining} slot${p.remaining === 1 ? "" : "s"} left`
  return `${p.count} algorithm${p.count === 1 ? "" : "s"} (${p.tier} tier${slotPart})`
}

export const AlgorithmListTool = Tool.define(
  "finny_algorithm_list",
  Effect.succeed({
    description:
      "List all saved trading algorithms for the current user. Returns one entry per unique algorithm name (latest version) plus the user's plan capacity so the model can reason about whether a new save will fit.",
    parameters,
    execute: (_params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_list",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const [algos, tier] = await Promise.all([Algorithm.list(), Plan.getTier()])
        const payload = buildAlgorithmListPayload(algos, tier)

        return {
          title: buildTitle(payload),
          // Always JSON, even when empty — keeps the schema consistent for
          // any caller that parses this output.
          output: JSON.stringify(payload, null, 2),
          metadata: {
            count: payload.count,
            capacity: payload.capacity,
            remaining: payload.remaining,
            tier: payload.tier,
          },
        }
      }),
  }),
)
