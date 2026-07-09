import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-scaffold.txt"
import { Templates } from "../algorithm/templates"
import { Validate } from "../algorithm/validate"
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"

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
  return { skipSmokeTest: new Set<string>(["custom", "dca", "golden-cross"]).has(templateType) }
}

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

        const evidence = await requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID)
        if (!evidence.ok) {
          return {
            title: "Scaffold blocked by missing evidence",
            output: evidence.text,
            metadata: {
              blocked: true,
              evidenceRequired: true,
              workspaceSlug: evidence.workspaceSlug,
              issues: evidence.issues,
              template: undefined,
              valid: undefined,
              warningCount: undefined,
            } as ScaffoldMetadata,
          }
        }

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
  }),
)
