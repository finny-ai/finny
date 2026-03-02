import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-save.txt"
import { Algorithm } from "../algorithm"

export const AlgorithmSaveTool = Tool.define("finny_algorithm_save", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("Short descriptive name for the algorithm (kebab-case)"),
    code: z.string().describe("The full strategy.py source code"),
    language: z.string().optional().describe("Programming language, defaults to python"),
    description: z.string().optional().describe("Brief human-readable summary of the strategy"),
    config: z.string().optional().describe("The config.json content as a string"),
    backtestCode: z.string().optional().describe("The backtest.py source code"),
    localPath: z.string().optional().describe("Local filesystem path where files were written"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "finny_algorithm_save",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const algo = await Algorithm.save({
      name: params.name,
      code: params.code,
      language: params.language,
      description: params.description,
      config: params.config,
      backtestCode: params.backtestCode,
      localPath: params.localPath,
    })

    return {
      title: `Saved "${algo.name}" v${algo.version}`,
      output: JSON.stringify(
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
      metadata: {
        algorithmId: algo.algorithmId,
        name: algo.name,
        version: algo.version,
      },
    }
  },
})
