import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const RESEARCH_DIR = ".finny/research"

export const SaveResearchReportTool = Tool.define("save_research_report", async () => {
  return {
    description:
      "Save a research report to the local file system. Use this to document your analysis, strategy ideas, and findings. " +
      "Reports are saved as markdown files in the .finny/research directory.",
    parameters: z.object({
      title: z.string().describe("Report title (will be used in filename and header)"),
      symbol: z.string().describe("Primary trading symbol this research is about"),
      strategy_type: z
        .string()
        .optional()
        .describe("Strategy type (e.g., 'momentum', 'mean-reversion', 'trend-following')"),
      summary: z.string().describe("Executive summary of the research findings"),
      market_analysis: z.string().optional().describe("Market analysis section content"),
      technical_analysis: z.string().optional().describe("Technical analysis section content"),
      strategy_recommendation: z.string().optional().describe("Strategy recommendation details"),
      risk_parameters: z.string().optional().describe("Risk management parameters and considerations"),
      additional_notes: z.string().optional().describe("Any additional notes or observations"),
    }),
    async execute(params, ctx) {
      const timestamp = new Date().toISOString()
      const dateStr = timestamp.split("T")[0]
      const timeStr = timestamp.split("T")[1].split(".")[0].replace(/:/g, "")

      // Sanitize title and symbol for filename
      const sanitizedTitle = params.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50)
      const sanitizedSymbol = params.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "")

      const filename = `${dateStr}-${timeStr}-${sanitizedSymbol}-${sanitizedTitle}.md`
      const researchDir = path.join(Instance.directory, RESEARCH_DIR)
      const filepath = path.join(researchDir, filename)

      // Build the report content
      const reportContent = buildReportContent({
        ...params,
        timestamp,
        filename,
      })

      try {
        // Ensure research directory exists
        await fs.promises.mkdir(researchDir, { recursive: true })

        // Write the report
        await fs.promises.writeFile(filepath, reportContent, "utf-8")

        return {
          title: "Research Report Saved",
          output: `Research report saved successfully!

File: ${filepath}
Title: ${params.title}
Symbol: ${params.symbol.toUpperCase()}
Strategy: ${params.strategy_type || "General Analysis"}

View with: /reports or cat ${filepath}`,
          metadata: {
            filepath,
            filename,
            symbol: params.symbol.toUpperCase(),
            title: params.title,
            timestamp,
          },
        }
      } catch (error: any) {
        return {
          title: "Save Report Error",
          output: `Failed to save research report: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const ListResearchReportsTool = Tool.define("list_research_reports", async () => {
  return {
    description:
      "List all saved research reports. Shows recent reports with their titles, symbols, and dates. " +
      "Use this to review past research and analysis.",
    parameters: z.object({
      symbol: z.string().optional().describe("Filter reports by symbol (optional)"),
      limit: z.number().optional().default(20).describe("Maximum number of reports to list (default 20)"),
    }),
    async execute(params, ctx) {
      const researchDir = path.join(Instance.directory, RESEARCH_DIR)

      try {
        // Check if directory exists
        const dirExists = await fs.promises
          .access(researchDir)
          .then(() => true)
          .catch(() => false)

        if (!dirExists) {
          return {
            title: "Research Reports",
            output: "No research reports found. Use save_research_report to create your first report.",
            metadata: { count: 0 },
          }
        }

        // List all markdown files
        const files = await fs.promises.readdir(researchDir)
        let reports = files
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse() // Most recent first

        // Filter by symbol if specified
        if (params.symbol) {
          const symbolUpper = params.symbol.toUpperCase()
          reports = reports.filter((f) => f.toUpperCase().includes(symbolUpper))
        }

        // Apply limit
        const limit = params.limit || 20
        reports = reports.slice(0, limit)

        if (reports.length === 0) {
          return {
            title: "Research Reports",
            output: params.symbol
              ? `No research reports found for ${params.symbol.toUpperCase()}.`
              : "No research reports found. Use save_research_report to create your first report.",
            metadata: { count: 0 },
          }
        }

        // Parse filenames to extract info
        const reportList = reports.map((filename) => {
          // Format: YYYY-MM-DD-HHMMSS-SYMBOL-title.md
          const parts = filename.replace(".md", "").split("-")
          const date = parts.slice(0, 3).join("-")
          const time = parts[3] || ""

          // Find symbol (uppercase part after time)
          let symbol = "Unknown"
          let title = filename
          if (parts.length > 4) {
            symbol = parts[4]
            title = parts.slice(5).join(" ")
          }

          return { filename, date, time, symbol, title }
        })

        const output = `Research Reports${params.symbol ? ` (filtered: ${params.symbol.toUpperCase()})` : ""}

${reportList.map((r, i) => `${i + 1}. [${r.date}] ${r.symbol}: ${r.title || r.filename}`).join("\n")}

Total: ${reportList.length} report(s)
Directory: ${researchDir}

To view a report, use: cat ${researchDir}/<filename>`

        return {
          title: "Research Reports",
          output,
          metadata: {
            count: reportList.length,
            reports: reportList,
            directory: researchDir,
          },
        }
      } catch (error: any) {
        return {
          title: "List Reports Error",
          output: `Failed to list research reports: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

function buildReportContent(params: {
  title: string
  symbol: string
  strategy_type?: string
  summary: string
  market_analysis?: string
  technical_analysis?: string
  strategy_recommendation?: string
  risk_parameters?: string
  additional_notes?: string
  timestamp: string
  filename: string
}): string {
  const sections: string[] = []

  // Header
  sections.push(`# Research Report: ${params.symbol.toUpperCase()} - ${params.title}`)
  sections.push("")
  sections.push(`**Generated:** ${params.timestamp}`)
  sections.push(`**Symbol:** ${params.symbol.toUpperCase()}`)
  if (params.strategy_type) {
    sections.push(`**Strategy Type:** ${params.strategy_type}`)
  }
  sections.push("")

  // Summary
  sections.push("## Summary")
  sections.push("")
  sections.push(params.summary)
  sections.push("")

  // Market Analysis
  if (params.market_analysis) {
    sections.push("## Market Analysis")
    sections.push("")
    sections.push(params.market_analysis)
    sections.push("")
  }

  // Technical Analysis
  if (params.technical_analysis) {
    sections.push("## Technical Analysis")
    sections.push("")
    sections.push(params.technical_analysis)
    sections.push("")
  }

  // Strategy Recommendation
  if (params.strategy_recommendation) {
    sections.push("## Strategy Recommendation")
    sections.push("")
    sections.push(params.strategy_recommendation)
    sections.push("")
  }

  // Risk Parameters
  if (params.risk_parameters) {
    sections.push("## Risk Parameters")
    sections.push("")
    sections.push(params.risk_parameters)
    sections.push("")
  }

  // Additional Notes
  if (params.additional_notes) {
    sections.push("## Additional Notes")
    sections.push("")
    sections.push(params.additional_notes)
    sections.push("")
  }

  // Footer
  sections.push("---")
  sections.push("")
  sections.push("*Generated by Finny Research Agent*")

  return sections.join("\n")
}
