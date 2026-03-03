import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-validate.txt"
import { Validate } from "../algorithm/validate"

export const AlgorithmValidateTool = Tool.define("finny_algorithm_validate", {
  description: DESCRIPTION,
  parameters: z.object({
    code: z.string().describe("The full Python strategy source code to validate"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "finny_algorithm_validate",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const result = await Validate.run(params.code)
    const output = Validate.format(result)

    return {
      title: result.valid
        ? result.warnings.length > 0
          ? `Valid (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`
          : "Valid"
        : `Invalid (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`,
      output,
      metadata: {
        valid: result.valid,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
      },
    }
  },
})
