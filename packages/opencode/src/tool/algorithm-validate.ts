import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-validate.txt"
import { Validate } from "../algorithm/validate"
import { StrategyContext } from "../task/strategy-context"

const parameters = z.object({
  code: z.string().describe("The full Python strategy source code to validate"),
  config: z.string().optional().describe("Optional config.json contents to validate against the strategy"),
})

type ValidationMetadata = {
  blocked: boolean
  evidenceRequired: boolean
  workspaceSlug: string | undefined
  issues: string[]
  valid: boolean | undefined
  errorCount: number | undefined
  warningCount: number | undefined
}

export const AlgorithmValidateTool = Tool.define(
  "finny_algorithm_validate",
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
              title: "Validation waiting for strategy context",
              output: StrategyContext.blockedOutput("Strategy validation", pending),
              metadata: {
                blocked: true,
                evidenceRequired: false,
                workspaceSlug: undefined,
                issues: pending.map((task) => `${task.subagentType}:${task.id}`),
                valid: undefined,
                errorCount: undefined,
                warningCount: undefined,
              } as ValidationMetadata,
            }
          }
          await Effect.runPromise(
            ctx.ask({
              permission: "finny_algorithm_validate",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            }),
          )

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
              blocked: false,
              evidenceRequired: false,
              workspaceSlug: undefined,
              issues: [],
              valid: result.valid,
              errorCount: result.errors.length,
              warningCount: result.warnings.length,
            } as ValidationMetadata,
          }
        }),
    }
  }),
)
