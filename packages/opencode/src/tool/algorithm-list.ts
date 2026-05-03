import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { Plan } from "../plan"

const parameters = z.object({})

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

        const algos = await Algorithm.list()

        // Collapse to one entry per unique name (latest version wins). This
        // hides historical/orphan rows so the model doesn't double-count
        // when checking whether the user is at their plan's save cap.
        const latestByName = new Map<string, (typeof algos)[number]>()
        for (const a of algos) {
          const prev = latestByName.get(a.name)
          if (!prev || a.version > prev.version) latestByName.set(a.name, a)
        }
        const unique = Array.from(latestByName.values()).sort((a, b) => b.time_updated - a.time_updated)

        const tier = await Plan.getTier()
        const capacity = Plan.SAVE_CAP[tier]
        const remaining = Number.isFinite(capacity) ? Math.max(0, capacity - unique.length) : null

        if (unique.length === 0) {
          return {
            title: "No algorithms",
            output: `No algorithms saved yet. Use Build mode to generate a trading algorithm. (Plan: ${tier}, capacity: ${Number.isFinite(capacity) ? capacity : "unlimited"})`,
            metadata: { count: 0, capacity, remaining, tier },
          }
        }

        const summary = unique.map((a) => ({
          name: a.name,
          version: a.version,
          status: a.status,
          language: a.language,
          description: a.description ?? "",
          updated: new Date(a.time_updated).toISOString(),
        }))

        const header = {
          count: unique.length,
          capacity: Number.isFinite(capacity) ? capacity : "unlimited",
          remaining: remaining ?? "unlimited",
          tier,
        }

        return {
          title: `${unique.length} algorithm${unique.length === 1 ? "" : "s"} (${tier} tier${Number.isFinite(capacity) ? `, ${remaining} slot${remaining === 1 ? "" : "s"} left` : ""})`,
          output: JSON.stringify({ ...header, algorithms: summary }, null, 2),
          metadata: { count: unique.length, capacity, remaining, tier },
        }
      }),
  }),
)
