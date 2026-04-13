import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"

const parameters = z.object({
  name: z.string().describe("The name of the algorithm to retrieve"),
})

export const AlgorithmGetTool = Tool.define(
  "finny_algorithm_get",
  Effect.succeed({
    description:
      "Get a saved trading algorithm by name. Returns the full algorithm details including code, config, backtest code, and metadata.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_get",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const algo = await Algorithm.get(params.name)

        const found = !!algo
        const metadata = { found }

        if (!algo) {
          return {
            title: "Not found",
            output: `No algorithm found with name "${params.name}". Use finny_algorithm_list to see available algorithms.`,
            metadata,
          }
        }

        return {
          title: `${algo.name} v${algo.version}`,
          output: JSON.stringify(
            {
              algorithmId: algo.algorithmId,
              name: algo.name,
              version: algo.version,
              status: algo.status,
              language: algo.language,
              description: algo.description ?? "",
              code: algo.code,
              config: algo.config ?? null,
              backtestCode: algo.backtestCode ?? null,
              localPath: algo.localPath ?? null,
              created: new Date(algo.time_created).toISOString(),
              updated: new Date(algo.time_updated).toISOString(),
            },
            null,
            2,
          ),
          metadata,
        }
      }),
  }),
)
