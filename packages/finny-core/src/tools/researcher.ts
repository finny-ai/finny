import { tool } from "@opencode-ai/plugin"
import { algoDir, algosRoot } from "../algo/paths"
import { DATA_NEWS_HEADLINES_DIR, DATA_NEWS_BODY_DIR } from "../algo/schemas"
import fs from "node:fs/promises"
import path from "node:path"

export const researcher = tool({
  description:
    "Dispatch the research subagent to deeply investigate a topic. " +
    "The researcher searches the web and Discord channels, deduplicates findings, " +
    "and writes structured news files (headlines + body articles) into the algorithm's data/news/ directory. " +
    "Use this when you need comprehensive research on a market event, political development, " +
    "or any topic relevant to a trading strategy. " +
    "This tool builds the prompt and returns it — the caller must dispatch it via the task tool with subagent_type 'researcher'.",
  args: {
    topic: tool.schema
      .string()
      .describe(
        "The research topic to investigate. Be specific about entities, events, and timeframes. " +
          "Example: 'trump visit to china may 2025 and market impact'",
      ),
    algorithm: tool.schema
      .string()
      .describe("The algorithm name (kebab-case) whose data/news/ directory should receive the research output."),
    channels: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Discord channels to check. Defaults to auto-selecting based on topic. " +
          "Options: trump, options-flow, dark-pool, china-us-news, market-news, congressional-trades",
      ),
    days: tool.schema
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7)
      .describe("How many days back to search (1-30, default 7)."),
  },
  async execute(args) {
    const root = algosRoot()
    const dir = algoDir(args.algorithm, root)

    try {
      await fs.stat(dir)
    } catch {
      return JSON.stringify({
        error: `Algorithm "${args.algorithm}" not found at ${dir}. Create the algorithm first.`,
      })
    }

    const headlinesDir = path.join(dir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(dir, DATA_NEWS_BODY_DIR)
    await fs.mkdir(headlinesDir, { recursive: true })
    await fs.mkdir(bodyDir, { recursive: true })

    const channelHint = args.channels?.length
      ? `Focus on these Discord channels: ${args.channels.join(", ")}`
      : "Auto-select relevant Discord channels based on the topic"

    const prompt = [
      `Research the following topic deeply and write findings to the algo data directory.`,
      ``,
      `## Topic`,
      `${args.topic}`,
      ``,
      `## Output directory`,
      `- Headlines: ${headlinesDir}`,
      `- Body articles: ${bodyDir}`,
      ``,
      `## Parameters`,
      `- Time range: last ${args.days} days`,
      `- ${channelHint}`,
      ``,
      `Begin research now. Search the web and Discord channels, deduplicate, and write all files.`,
    ].join("\n")

    return JSON.stringify({
      prompt,
      subagent: "researcher",
      algorithm: args.algorithm,
      dataDir: dir,
    })
  },
})
