import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-validate.txt"
import { Validate } from "../algorithm/validate"

const parameters = z.object({
  code: z.string().describe("The full Python strategy source code to validate"),
  config: z.string().optional().describe("Optional config.json contents to validate against the strategy"),
})

export const AlgorithmValidateTool = Tool.define(
  "finny_algorithm_validate",
  Effect.succeed({
    description: DESCRIPTION,
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_validate",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const result = await Validate.run(params.code, { config: params.config })
        const output = Validate.format(result)

        return {
          title: result.valid
            ? result.warnings.length > 0
              ? `Valid (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`
              : "Valid"
            : result.errors.length > 0
              ? `Invalid (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`
              : `Invalid (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"} must clear)`,
          output,
          metadata: {
            valid: result.valid,
            errorCount: result.errors.length,
            warningCount: result.warnings.length,
          },
        }
      }),
  }),
)
