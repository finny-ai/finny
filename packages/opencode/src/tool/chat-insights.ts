import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const INSIGHTS_DIR = ".finny/insights"

const INSIGHT_CATEGORIES = ["strategy", "market", "risk", "learning", "decision", "observation"] as const
type InsightCategory = (typeof INSIGHT_CATEGORIES)[number]

export const SaveChatInsightTool = Tool.define("save_chat_insight", async () => {
  return {
    description:
      "Save a valuable insight from the conversation. Use this to document important observations, " +
      "strategy ideas, market analysis, risk notes, or learning moments that you want to remember. " +
      "Insights are saved as markdown files in the .finny/insights directory.",
    parameters: z.object({
      title: z.string().describe("Short, descriptive title for the insight"),
      category: z
        .enum(INSIGHT_CATEGORIES)
        .describe(
          "Category: strategy (trading ideas), market (market observations), risk (risk notes), " +
            "learning (lessons learned), decision (decision rationale), observation (general observations)"
        ),
      content: z.string().describe("The main insight content - what you want to remember"),
      symbols: z
        .array(z.string())
        .optional()
        .describe("Related trading symbols (e.g., ['BTC', 'ETH'])"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Additional tags for categorization (e.g., ['momentum', 'bullish'])"),
      priority: z
        .enum(["low", "medium", "high"])
        .optional()
        .default("medium")
        .describe("Importance level of this insight"),
    }),
    async execute(params, ctx) {
      const timestamp = new Date().toISOString()
      const dateStr = timestamp.split("T")[0]
      const timeStr = timestamp.split("T")[1].split(".")[0].replace(/:/g, "")

      // Sanitize title for filename
      const sanitizedTitle = params.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50)

      const filename = `${dateStr}-${timeStr}-${params.category}-${sanitizedTitle}.md`
      const insightsDir = path.join(Instance.directory, INSIGHTS_DIR)
      const filepath = path.join(insightsDir, filename)

      // Build the insight content
      const content = buildInsightContent({
        ...params,
        timestamp,
        filename,
      })

      try {
        // Ensure insights directory exists
        await fs.promises.mkdir(insightsDir, { recursive: true })

        // Write the insight
        await fs.promises.writeFile(filepath, content, "utf-8")

        return {
          title: "Insight Saved",
          output: `Insight saved successfully!

**Title:** ${params.title}
**Category:** ${params.category}
**Priority:** ${params.priority || "medium"}
${params.symbols?.length ? `**Symbols:** ${params.symbols.join(", ")}` : ""}
${params.tags?.length ? `**Tags:** ${params.tags.join(", ")}` : ""}

**File:** ${filepath}

View all insights with: /insights`,
          metadata: {
            filepath,
            filename,
            category: params.category,
            title: params.title,
            priority: params.priority,
            symbols: params.symbols,
            tags: params.tags,
            timestamp,
          },
        }
      } catch (error: any) {
        return {
          title: "Save Insight Error",
          output: `Failed to save insight: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const ListChatInsightsTool = Tool.define("list_chat_insights", async () => {
  return {
    description:
      "List all saved chat insights. Shows recent insights with their titles, categories, and dates. " +
      "Use this to review past observations and ideas.",
    parameters: z.object({
      category: z
        .enum([...INSIGHT_CATEGORIES, "all"])
        .optional()
        .default("all")
        .describe("Filter insights by category"),
      symbol: z.string().optional().describe("Filter insights by symbol"),
      tag: z.string().optional().describe("Filter insights by tag"),
      limit: z.number().optional().default(20).describe("Maximum number of insights to list (default 20)"),
    }),
    async execute(params, ctx) {
      const insightsDir = path.join(Instance.directory, INSIGHTS_DIR)

      try {
        // Check if directory exists
        const dirExists = await fs.promises
          .access(insightsDir)
          .then(() => true)
          .catch(() => false)

        if (!dirExists) {
          return {
            title: "Chat Insights",
            output: `No insights found. Use save_chat_insight to save your first insight.

**What to save:**
- Strategy ideas and trading hypotheses
- Market observations and analysis
- Risk notes and concerns
- Lessons learned from trades
- Decision rationale for future reference`,
            metadata: { count: 0 },
          }
        }

        // List all markdown files
        const files = await fs.promises.readdir(insightsDir)
        let insights = files.filter((f) => f.endsWith(".md")).sort().reverse() // Most recent first

        // Apply category filter
        if (params.category && params.category !== "all") {
          insights = insights.filter((f) => f.includes(`-${params.category}-`))
        }

        // For symbol and tag filtering, we need to read file contents
        if (params.symbol || params.tag) {
          const filtered: string[] = []
          for (const filename of insights) {
            const filepath = path.join(insightsDir, filename)
            const content = await fs.promises.readFile(filepath, "utf-8")

            if (params.symbol) {
              const symbolUpper = params.symbol.toUpperCase()
              if (!content.toUpperCase().includes(symbolUpper)) continue
            }

            if (params.tag) {
              const tagLower = params.tag.toLowerCase()
              if (!content.toLowerCase().includes(tagLower)) continue
            }

            filtered.push(filename)
          }
          insights = filtered
        }

        // Apply limit
        const limit = params.limit || 20
        insights = insights.slice(0, limit)

        if (insights.length === 0) {
          const filterDesc = []
          if (params.category && params.category !== "all") filterDesc.push(`category: ${params.category}`)
          if (params.symbol) filterDesc.push(`symbol: ${params.symbol}`)
          if (params.tag) filterDesc.push(`tag: ${params.tag}`)

          return {
            title: "Chat Insights",
            output: filterDesc.length > 0
              ? `No insights found matching filters: ${filterDesc.join(", ")}`
              : "No insights found. Use save_chat_insight to save your first insight.",
            metadata: { count: 0, filters: { category: params.category, symbol: params.symbol, tag: params.tag } },
          }
        }

        // Parse filenames to extract info
        const insightList = insights.map((filename) => {
          // Format: YYYY-MM-DD-HHMMSS-category-title.md
          const parts = filename.replace(".md", "").split("-")
          const date = parts.slice(0, 3).join("-")
          const time = parts[3] || ""
          const category = parts[4] || "unknown"
          const title = parts.slice(5).join(" ")

          return { filename, date, time, category, title }
        })

        // Group by category for display
        const byCategory: Record<string, typeof insightList> = {}
        for (const insight of insightList) {
          if (!byCategory[insight.category]) byCategory[insight.category] = []
          byCategory[insight.category].push(insight)
        }

        const lines: string[] = []
        lines.push("# Chat Insights")
        lines.push("")

        if (params.category && params.category !== "all") {
          lines.push(`*Filtered by category: ${params.category}*`)
        }
        if (params.symbol) {
          lines.push(`*Filtered by symbol: ${params.symbol.toUpperCase()}*`)
        }
        if (params.tag) {
          lines.push(`*Filtered by tag: ${params.tag}*`)
        }
        lines.push("")

        for (const [category, categoryInsights] of Object.entries(byCategory)) {
          const emoji = getCategoryEmoji(category as InsightCategory)
          lines.push(`## ${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)}`)
          lines.push("")
          for (const insight of categoryInsights) {
            lines.push(`- **[${insight.date}]** ${insight.title || insight.filename}`)
          }
          lines.push("")
        }

        lines.push("---")
        lines.push(`**Total:** ${insightList.length} insight(s)`)
        lines.push(`**Directory:** ${insightsDir}`)
        lines.push("")
        lines.push("To view an insight: `cat ${filepath}`")

        return {
          title: "Chat Insights",
          output: lines.join("\n"),
          metadata: {
            count: insightList.length,
            insights: insightList,
            directory: insightsDir,
            by_category: Object.fromEntries(
              Object.entries(byCategory).map(([k, v]) => [k, v.length])
            ),
          },
        }
      } catch (error: any) {
        return {
          title: "List Insights Error",
          output: `Failed to list insights: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

function getCategoryEmoji(category: InsightCategory | string): string {
  const emojis: Record<string, string> = {
    strategy: "💡",
    market: "📊",
    risk: "⚠️",
    learning: "📚",
    decision: "🎯",
    observation: "👁️",
  }
  return emojis[category] || "📝"
}

function buildInsightContent(params: {
  title: string
  category: InsightCategory
  content: string
  symbols?: string[]
  tags?: string[]
  priority?: string
  timestamp: string
  filename: string
}): string {
  const sections: string[] = []

  // YAML frontmatter
  sections.push("---")
  sections.push(`title: "${params.title}"`)
  sections.push(`category: ${params.category}`)
  sections.push(`priority: ${params.priority || "medium"}`)
  sections.push(`created: ${params.timestamp}`)
  if (params.symbols?.length) {
    sections.push(`symbols: [${params.symbols.map((s) => `"${s.toUpperCase()}"`).join(", ")}]`)
  }
  if (params.tags?.length) {
    sections.push(`tags: [${params.tags.map((t) => `"${t}"`).join(", ")}]`)
  }
  sections.push("---")
  sections.push("")

  // Header
  sections.push(`# ${params.title}`)
  sections.push("")

  // Metadata line
  const metaParts = [`**Category:** ${params.category}`, `**Priority:** ${params.priority || "medium"}`]
  if (params.symbols?.length) {
    metaParts.push(`**Symbols:** ${params.symbols.join(", ")}`)
  }
  if (params.tags?.length) {
    metaParts.push(`**Tags:** ${params.tags.join(", ")}`)
  }
  sections.push(metaParts.join(" | "))
  sections.push("")
  sections.push(`*Saved: ${params.timestamp}*`)
  sections.push("")

  // Main content
  sections.push("## Insight")
  sections.push("")
  sections.push(params.content)
  sections.push("")

  // Footer
  sections.push("---")
  sections.push("")
  sections.push("*Saved by Finny Chat Agent*")

  return sections.join("\n")
}
