import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-save.txt"
import { Algorithm } from "../algorithm"
import { Validate } from "../algorithm/validate"
import { Plan } from "../plan"

const parameters = z.object({
  name: z.string().describe("Short descriptive name for the algorithm (kebab-case)"),
  code: z.string().describe("The full strategy.py source code"),
  language: z.string().optional().describe("Programming language, defaults to python"),
  description: z.string().optional().describe("Brief human-readable summary of the strategy"),
  config: z.string().optional().describe("The config.json content as a string"),
  backtestCode: z.string().optional().describe("The backtest.py source code"),
  localPath: z.string().optional().describe("Local filesystem path where files were written"),
})

export const AlgorithmSaveTool = Tool.define(
  "finny_algorithm_save",
  Effect.succeed({
    description: DESCRIPTION,
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_algorithm_save",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const validation = await Validate.run(params.code)

        if (!validation.valid) {
          return {
            title: "Save blocked — validation failed",
            output: Validate.format(validation),
            metadata: {
              blocked: true as const,
              errorCount: validation.errors.length,
              warningCount: validation.warnings.length,
            } as Record<string, unknown>,
          }
        }

        const existingAlgo = await Algorithm.get(params.name)
        if (!existingAlgo && !(await Plan.isPro())) {
          const allAlgos = await Algorithm.list()
          if (allAlgos.length >= 3) {
            return {
              title: "Save blocked — free tier limit",
              output:
                "Free users can save up to 3 algorithms. Delete an existing algorithm or upgrade to Finny Pro for unlimited algorithms.\n\nTo delete an algorithm, go to My Algos and click Delete on one you no longer need.",
              metadata: { blocked: true } as Record<string, unknown>,
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
            },
            null,
            2,
          ),
        ]

        if (validation.warnings.length > 0) {
          parts.push("", Validate.format(validation))
        }

        return {
          title: `Saved "${algo.name}" v${algo.version}`,
          output: parts.join("\n"),
          metadata: {
            algorithmId: algo.algorithmId,
            name: algo.name,
            version: algo.version,
            warningCount: validation.warnings.length,
          } as Record<string, unknown>,
        }
      }),
  }),
)
