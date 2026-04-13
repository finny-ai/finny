import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-scaffold.txt"
import { Templates } from "../algorithm/templates"
import { Validate } from "../algorithm/validate"

const parameters = z.object({
  template_type: z
    .enum(["momentum", "mean-reversion", "breakout", "dca", "golden-cross", "scalping", "custom"])
    .describe("The type of strategy template to generate"),
})

export const AlgorithmScaffoldTool = Tool.define(
  "finny_algorithm_scaffold",
  Effect.succeed({
    description: DESCRIPTION,
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_scaffold",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const code = Templates.get(params.template_type)
        const result = await Validate.run(code)
        const desc = Templates.describe(params.template_type)

        const parts: string[] = [
          `## ${params.template_type} strategy`,
          desc,
          "",
          "```python",
          code.trimEnd(),
          "```",
          "",
          "## Validation",
          Validate.format(result),
        ]

        return {
          title: `${params.template_type} template`,
          output: parts.join("\n"),
          metadata: {
            template: params.template_type,
            valid: result.valid,
            warningCount: result.warnings.length,
          },
        }
      }),
  }),
)
