import z from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { algosRoot, algoDir } from "@finny-ai/core/algo/paths"
import { DATA_NEWS_HEADLINES_DIR, DATA_NEWS_BODY_DIR } from "@finny-ai/core/algo/schemas"

const parameters = z.object({
  topic: z
    .string()
    .describe(
      "The research topic to investigate. Be specific about entities, events, and timeframes. " +
        "Example: 'trump visit to china may 2025 and market impact'",
    ),
  algorithm: z
    .string()
    .describe("The algorithm name (kebab-case) whose data/news/ directory should receive the research output."),
  channels: z
    .array(z.string())
    .optional()
    .describe(
      "Discord channels to check. Defaults to auto-selecting based on topic. " +
        "Options: trump, options-flow, dark-pool, china-us-news, market-news, congressional-trades",
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe("How many days back to search (1-30, default 7)."),
})

export const ResearchDispatchTool = Tool.define(
  "finny_research_dispatch",
  Effect.succeed({
    description:
      "Prepare a deep-research task for the researcher subagent. Validates the algorithm exists, " +
      "creates the output directories, and returns a structured prompt. After calling this tool, " +
      "dispatch the research by calling task(subagent_type: 'researcher', prompt: <the returned prompt>, " +
      "mode: 'background', description: 'Research: <topic>').",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        const root = algosRoot()
        let dir: string
        try {
          dir = algoDir(params.algorithm, root)
        } catch {
          return {
            title: "Invalid algorithm name",
            output: `"${params.algorithm}" is not a valid kebab-case algorithm name.`,
            metadata: { error: "invalid_name" },
          }
        }

        try {
          await fs.stat(dir)
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            return {
              title: "Algorithm not found",
              output: `Algorithm "${params.algorithm}" not found at ${dir}. Create the algorithm first.`,
              metadata: { error: "not_found" },
            }
          }
          return {
            title: "Filesystem error",
            output: `Could not access algorithm directory at ${dir}: ${err?.message ?? err}`,
            metadata: { error: "fs_error" },
          }
        }

        await ctx.ask({
          permission: "finny_research_dispatch",
          patterns: ["*"],
          always: ["*"],
          metadata: { topic: params.topic, algorithm: params.algorithm },
        })

        const headlinesDir = path.join(dir, DATA_NEWS_HEADLINES_DIR)
        const bodyDir = path.join(dir, DATA_NEWS_BODY_DIR)
        await fs.mkdir(headlinesDir, { recursive: true })
        await fs.mkdir(bodyDir, { recursive: true })

        const channelHint = params.channels?.length
          ? `Focus on these Discord channels: ${params.channels.join(", ")}`
          : "Auto-select relevant Discord channels based on the topic"

        const prompt = [
          `Research the following topic deeply and write findings to the algo data directory.`,
          ``,
          `## Topic`,
          `${params.topic}`,
          ``,
          `## Output directory`,
          `- Headlines: ${headlinesDir}`,
          `- Body articles: ${bodyDir}`,
          ``,
          `## Parameters`,
          `- Time range: last ${params.days} days`,
          `- ${channelHint}`,
          ``,
          `Begin research now. Search the web and Discord channels, deduplicate, and write all files.`,
        ].join("\n")

        return {
          title: `Research dispatch: ${params.topic.slice(0, 50)}`,
          output: prompt,
          metadata: {
            algorithm: params.algorithm,
            topic: params.topic,
            subagent: "researcher",
            dataDir: dir,
          },
        }
      }),
  }),
)
