import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-scaffold.txt"
import { Templates } from "../algorithm/templates"
import { Validate } from "../algorithm/validate"
import { StrategyContext } from "../task/strategy-context"

const parameters = z.object({
  template_type: z
    .enum([...Templates.TYPES] as [Templates.TemplateType, ...Templates.TemplateType[]])
    .describe("The type of strategy template to generate"),
})

type ScaffoldMetadata = {
  blocked: boolean
  evidenceRequired: boolean
  workspaceSlug: string | undefined
  issues: string[]
  template: z.infer<typeof parameters>["template_type"] | undefined
  valid: boolean | undefined
  warningCount: number | undefined
}

export function scaffoldValidationOptions(templateType: z.infer<typeof parameters>["template_type"]) {
  return { skipSmokeTest: new Set<string>(["custom", "golden-cross"]).has(templateType) }
}

export const AlgorithmScaffoldTool = Tool.define(
  "finny_algorithm_scaffold",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.promise(async () => {
          const pending = await StrategyContext.pendingTasks(ctx.sessionID, database, ctx.messages)
          if (pending.length > 0) {
            return {
              title: "Scaffold waiting for strategy context",
              output: StrategyContext.blockedOutput("Strategy scaffolding", pending),
              metadata: {
                blocked: true,
                evidenceRequired: false,
                workspaceSlug: undefined,
                issues: pending.map((task) => `${task.subagentType}:${task.id}`),
                template: undefined,
                valid: undefined,
                warningCount: undefined,
              } as ScaffoldMetadata,
            }
          }
          await Effect.runPromise(
            ctx.ask({
              permission: "finny_algorithm_scaffold",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            }),
          )

          const code = Templates.get(params.template_type)
          const result = await Validate.run(code, scaffoldValidationOptions(params.template_type))
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
              blocked: false,
              evidenceRequired: false,
              workspaceSlug: undefined,
              issues: [],
              template: params.template_type,
              valid: result.valid,
              warningCount: result.warnings.length,
            } as ScaffoldMetadata,
          }
        }),
    }
  }),
)
