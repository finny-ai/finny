import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"

const parameters = z.object({})

export const AlgorithmListTool = Tool.define(
  "finny_algorithm_list",
  Effect.succeed({
    description:
      "List all saved trading algorithms for the current user. Returns a JSON array of algorithm summaries including name, version, status, language, and timestamps.",
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

        if (algos.length === 0) {
          return {
            title: "No algorithms",
            output: "No algorithms saved yet. Use Build mode to generate a trading algorithm.",
            metadata: { count: 0 },
          }
        }

        const summary = algos.map((a) => ({
          name: a.name,
          version: a.version,
          status: a.status,
          language: a.language,
          description: a.description ?? "",
          updated: new Date(a.time_updated).toISOString(),
        }))

        return {
          title: `${algos.length} algorithm${algos.length === 1 ? "" : "s"}`,
          output: JSON.stringify(summary, null, 2),
          metadata: { count: algos.length },
        }
      }),
  }),
)
