import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"

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
  /** always null — local saves are unlimited; retained for schema compatibility */
  capacity: number | null
  /** always null — local saves are unlimited; retained for schema compatibility */
  remaining: number | null
  algorithms: AlgorithmSummary[]
}

/**
 * Pure helper — exposed for testing. Collapses rows to one entry per unique
 * name (latest version wins) and reports cap usage in a JSON-safe shape:
 * `null` is used for both `capacity` and `remaining` because local saves are
 * unlimited, so callers never have to deal with `Infinity` (which
 * JSON.stringify coerces to `null` anyway).
 */
export function buildAlgorithmListPayload(algos: ReadonlyArray<Algorithm.Info>): AlgorithmListPayload {
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

  const algorithms: AlgorithmSummary[] = unique.map((a) => ({
    name: a.name,
    version: a.version,
    status: a.status,
    language: a.language,
    description: a.description ?? "",
    updated: new Date(a.time_updated).toISOString(),
  }))

  return { count: unique.length, capacity: null, remaining: null, algorithms }
}

function buildTitle(p: AlgorithmListPayload): string {
  if (p.count === 0) return "No algorithms"
  return `${p.count} algorithm${p.count === 1 ? "" : "s"}`
}

export const AlgorithmListTool = Tool.define(
  "finny_algorithm_list",
  Effect.succeed({
    description:
      "List all saved trading algorithms for the current user. Returns one entry per unique algorithm name (latest version). Capacity fields are retained for compatibility; null means local saves are unlimited.",
    parameters,
    execute: (_params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_list",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const algos = await Algorithm.list()
        const payload = buildAlgorithmListPayload(algos)

        return {
          title: buildTitle(payload),
          // Always JSON, even when empty — keeps the schema consistent for
          // any caller that parses this output.
          output: JSON.stringify(payload, null, 2),
          metadata: {
            count: payload.count,
            capacity: payload.capacity,
            remaining: payload.remaining,
          },
        }
      }),
  }),
)
