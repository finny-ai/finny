import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const BUILD_INSIGHTS_DIR = ".finny/build-insights"

const BUILD_INSIGHT_CATEGORIES = [
  "pattern",      // Design patterns and coding patterns
  "bug-fix",      // Bug fixes and their solutions
  "optimization", // Performance optimizations
  "parameter",    // Parameter tuning discoveries
  "idea",         // Strategy ideas to explore
  "lesson",       // Lessons learned
] as const

type BuildInsightCategory = (typeof BUILD_INSIGHT_CATEGORIES)[number]

export const SaveBuildInsightTool = Tool.define("save_build_insight", async () => {
  return {
    description:
      "Save a coding insight or strategy idea during the build process. Use this to document " +
      "patterns discovered, bugs fixed, optimizations found, parameter tunings, or strategy ideas. " +
      "Insights are saved as markdown files in .finny/build-insights/ for future reference.",
    parameters: z.object({
      title: z.string().describe("Short, descriptive title for the insight"),
      category: z
        .enum(BUILD_INSIGHT_CATEGORIES)
        .describe(
          "Category: pattern (design patterns), bug-fix (bugs and fixes), optimization (performance), " +
            "parameter (tuning discoveries), idea (strategy ideas), lesson (lessons learned)"
        ),
      content: z.string().describe("The main insight content - what you learned or discovered"),
      strategy_name: z
        .string()
        .optional()
        .describe("Related strategy name (if applicable)"),
      code_snippet: z
        .string()
        .optional()
        .describe("Relevant code snippet to include"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Additional tags for categorization (e.g., ['rsi', 'performance', 'python'])"),
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
      const insightsDir = path.join(Instance.directory, BUILD_INSIGHTS_DIR)
      const filepath = path.join(insightsDir, filename)

      // Build the insight content
      const content = buildBuildInsightContent({
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
          title: "Build Insight Saved",
          output: `Insight saved successfully!

**Title:** ${params.title}
**Category:** ${getCategoryEmoji(params.category)} ${params.category}
**Priority:** ${params.priority || "medium"}
${params.strategy_name ? `**Strategy:** ${params.strategy_name}` : ""}
${params.tags?.length ? `**Tags:** ${params.tags.join(", ")}` : ""}

**File:** ${filepath}

View all build insights with: /build-insights`,
          metadata: {
            filepath,
            filename,
            category: params.category,
            title: params.title,
            priority: params.priority,
            strategy_name: params.strategy_name,
            tags: params.tags,
            timestamp,
          },
        }
      } catch (error: any) {
        return {
          title: "Save Insight Error",
          output: `Failed to save build insight: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const ListBuildInsightsTool = Tool.define("list_build_insights", async () => {
  return {
    description:
      "List all saved build insights. Shows recent insights with their titles, categories, and dates. " +
      "Use this to review past coding learnings, bug fixes, and strategy ideas.",
    parameters: z.object({
      category: z
        .enum([...BUILD_INSIGHT_CATEGORIES, "all"])
        .optional()
        .default("all")
        .describe("Filter insights by category"),
      strategy: z.string().optional().describe("Filter insights by strategy name"),
      tag: z.string().optional().describe("Filter insights by tag"),
      limit: z.number().optional().default(20).describe("Maximum number of insights to list (default 20)"),
    }),
    async execute(params, ctx) {
      const insightsDir = path.join(Instance.directory, BUILD_INSIGHTS_DIR)

      try {
        // Check if directory exists
        const dirExists = await fs.promises
          .access(insightsDir)
          .then(() => true)
          .catch(() => false)

        if (!dirExists) {
          return {
            title: "Build Insights",
            output: `No build insights found. Use save_build_insight to save your first insight.

**What to save:**
- 🔧 **pattern**: Useful coding patterns discovered
- 🐛 **bug-fix**: Bugs you fixed and how
- ⚡ **optimization**: Performance improvements
- 🎛️ **parameter**: Parameter tuning discoveries
- 💡 **idea**: Strategy ideas to explore later
- 📖 **lesson**: Lessons learned from development`,
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

        // For strategy and tag filtering, read file contents
        if (params.strategy || params.tag) {
          const filtered: string[] = []
          for (const filename of insights) {
            const filepath = path.join(insightsDir, filename)
            const content = await fs.promises.readFile(filepath, "utf-8")

            if (params.strategy) {
              if (!content.toLowerCase().includes(params.strategy.toLowerCase())) continue
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
          if (params.strategy) filterDesc.push(`strategy: ${params.strategy}`)
          if (params.tag) filterDesc.push(`tag: ${params.tag}`)

          return {
            title: "Build Insights",
            output: filterDesc.length > 0
              ? `No insights found matching filters: ${filterDesc.join(", ")}`
              : "No insights found. Use save_build_insight to save your first insight.",
            metadata: { count: 0, filters: { category: params.category, strategy: params.strategy, tag: params.tag } },
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
        lines.push("# Build Insights")
        lines.push("")

        if (params.category && params.category !== "all") {
          lines.push(`*Filtered by category: ${params.category}*`)
        }
        if (params.strategy) {
          lines.push(`*Filtered by strategy: ${params.strategy}*`)
        }
        if (params.tag) {
          lines.push(`*Filtered by tag: ${params.tag}*`)
        }
        lines.push("")

        // Define category order
        const categoryOrder: string[] = ["bug-fix", "pattern", "optimization", "parameter", "idea", "lesson"]

        for (const category of categoryOrder) {
          const categoryInsights = byCategory[category]
          if (!categoryInsights || categoryInsights.length === 0) continue

          const emoji = getCategoryEmoji(category as BuildInsightCategory)
          lines.push(`## ${emoji} ${formatCategoryName(category)}`)
          lines.push("")
          for (const insight of categoryInsights) {
            lines.push(`- **[${insight.date}]** ${insight.title || insight.filename}`)
          }
          lines.push("")
        }

        // Handle any unknown categories
        for (const [category, categoryInsights] of Object.entries(byCategory)) {
          if (categoryOrder.includes(category)) continue
          const emoji = getCategoryEmoji(category as BuildInsightCategory)
          lines.push(`## ${emoji} ${formatCategoryName(category)}`)
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
          title: "Build Insights",
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
          output: `Failed to list build insights: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

function getCategoryEmoji(category: BuildInsightCategory | string): string {
  const emojis: Record<string, string> = {
    pattern: "🔧",
    "bug-fix": "🐛",
    optimization: "⚡",
    parameter: "🎛️",
    idea: "💡",
    lesson: "📖",
  }
  return emojis[category] || "📝"
}

function formatCategoryName(category: string): string {
  const names: Record<string, string> = {
    pattern: "Patterns",
    "bug-fix": "Bug Fixes",
    optimization: "Optimizations",
    parameter: "Parameters",
    idea: "Ideas",
    lesson: "Lessons",
  }
  return names[category] || category.charAt(0).toUpperCase() + category.slice(1)
}

function buildBuildInsightContent(params: {
  title: string
  category: BuildInsightCategory
  content: string
  strategy_name?: string
  code_snippet?: string
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
  if (params.strategy_name) {
    sections.push(`strategy: "${params.strategy_name}"`)
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
  const metaParts = [
    `**Category:** ${getCategoryEmoji(params.category)} ${params.category}`,
    `**Priority:** ${params.priority || "medium"}`,
  ]
  if (params.strategy_name) {
    metaParts.push(`**Strategy:** ${params.strategy_name}`)
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

  // Code snippet if provided
  if (params.code_snippet) {
    sections.push("## Code")
    sections.push("")
    sections.push("```python")
    sections.push(params.code_snippet)
    sections.push("```")
    sections.push("")
  }

  // Footer
  sections.push("---")
  sections.push("")
  sections.push("*Saved by Finny Build Agent*")

  return sections.join("\n")
}
