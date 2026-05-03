import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-save.txt"
import { Algorithm } from "../algorithm"
import { Validate } from "../algorithm/validate"
import { RetryOrchestrator } from "../algorithm/retry-orchestrator"
import { Plan } from "../plan"
import { Bus } from "../bus"

const parameters = z.object({
  name: z.string().describe("Short descriptive name for the algorithm (kebab-case)"),
  code: z.string().describe("The full strategy.py source code"),
  language: z.string().optional().describe("Programming language, defaults to python"),
  description: z.string().optional().describe("Brief human-readable summary of the strategy"),
  config: z.string().optional().describe("The config.json content as a string"),
  backtestCode: z.string().optional().describe("The backtest.py source code"),
  localPath: z.string().optional().describe("Local filesystem path where files were written"),
})

// Payload the async body returns: the tool's ExecuteResult-shaped value, plus (optionally)
// a regenerating event to publish once we're back in an Effect context.
type SaveOutcome = {
  result: {
    title: string
    output: string
    metadata: Record<string, unknown>
  }
  regenEvent?: {
    sessionID: string
    algorithmName: string
    attempt: number
    maxAttempts: number
    errorCodes: string[]
  }
}

export const AlgorithmSaveTool = Tool.define(
  "finny_algorithm_save",
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.promise(async (): Promise<SaveOutcome> => {
            const _permission = await ctx.ask({
              permission: "finny_algorithm_save",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            })

            // Run validation through the retry orchestrator so the attempt counter,
            // transient flagging, and max-retry handling all live in one place.
            const validation = await RetryOrchestrator.attempt({
              sessionID: ctx.sessionID,
              algorithmName: params.name,
              code: params.code,
              config: params.config,
            })

            // Validation failed, but we still have budget — tell the agent to rewrite.
            // Marked `transient: true` so the TUI suppresses this from the user.
            if (validation.kind === "retry") {
              const errorCodes = validation.diagnostics.map((d) => d.code)
              return {
                result: {
                  title: `Validation failed — regenerating (${validation.attempt}/${validation.maxAttempts})`,
                  output: RetryOrchestrator.buildRetryInstruction(validation),
                  metadata: {
                    blocked: true,
                    retry: true,
                    transient: true,
                    attempt: validation.attempt,
                    maxAttempts: validation.maxAttempts,
                    errorCount: validation.diagnostics.length,
                    errorCodes,
                  },
                },
                regenEvent: {
                  sessionID: ctx.sessionID,
                  algorithmName: params.name,
                  attempt: validation.attempt,
                  maxAttempts: validation.maxAttempts,
                  errorCodes,
                },
              }
            }

            // Exhausted all retries — surface a clean, user-visible error.
            if (validation.kind === "exhausted") {
              return {
                result: {
                  title: "Generation failed after 3 attempts",
                  output: RetryOrchestrator.buildExhaustedMessage(validation),
                  metadata: {
                    blocked: true,
                    retry: false,
                    transient: false,
                    exhausted: true,
                    attempts: validation.attempts,
                  },
                },
              }
            }

            // Validation passed — proceed with save.
            const existingAlgo = await Algorithm.get(params.name)
            if (!existingAlgo) {
              const tier = await Plan.getTier()
              const cap = Plan.SAVE_CAP[tier]
              if (Number.isFinite(cap)) {
                const allAlgos = await Algorithm.list()
                // Count unique algorithm names, not rows. Historical /
                // orphaned rows under the same name should not consume cap
                // slots — this matches what algorithm-list now shows.
                const uniqueCount = new Set(allAlgos.map((a) => a.name)).size
                if (uniqueCount >= cap) {
                  const upgradeTo = tier === "free" ? "Finny Lite (15) or Finny Pro (unlimited)" : "Finny Pro for unlimited algorithms"
                  return {
                    result: {
                      title: `Save blocked — ${tier} tier limit`,
                      output:
                        `Your plan (${tier}) allows up to ${cap} saved algorithms. Delete an existing algorithm or upgrade to ${upgradeTo}.\n\nTo delete an algorithm, go to My Algos and click Delete on one you no longer need.`,
                      metadata: { blocked: true },
                    },
                  }
                }
              }
            }

            const algo = await Algorithm.save({
              name: params.name,
              code: params.code,
              language: params.language,
              description: params.description,
              config: params.config,
              backtestCode: params.backtestCode,
              localPath: params.localPath,
            })

            const parts: string[] = [
              JSON.stringify(
                {
                  algorithmId: algo.algorithmId,
                  name: algo.name,
                  version: algo.version,
                  status: algo.status,
                  language: algo.language,
                  validationAttempts: validation.attempts,
                },
                null,
                2,
              ),
            ]

            if (validation.warnings.length > 0) {
              parts.push("", Validate.format({ valid: true, errors: [], warnings: validation.warnings }))
            }

            return {
              result: {
                title: `Saved "${algo.name}" v${algo.version}`,
                output: parts.join("\n"),
                metadata: {
                  algorithmId: algo.algorithmId,
                  name: algo.name,
                  version: algo.version,
                  warningCount: validation.warnings.length,
                  validationAttempts: validation.attempts,
                },
              },
            }
          })

          // Publish the regenerating event, if any. Done in the outer Effect.gen so we
          // have access to Bus.Service. Failures here must not fail the tool call.
          if (outcome.regenEvent) {
            yield* bus.publish(Algorithm.Event.Regenerating, outcome.regenEvent).pipe(Effect.catch(() => Effect.void))
          }

          return outcome.result
        }),
    }
  }),
)
