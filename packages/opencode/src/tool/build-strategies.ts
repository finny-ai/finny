import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const STRATEGY_DIRS = ["strategies", "packages/finny/strategies"]

async function findStrategyDirs(): Promise<string[]> {
  const dirs: string[] = []
  for (const dir of STRATEGY_DIRS) {
    const fullPath = path.join(Instance.directory, dir)
    const exists = await fs.promises
      .access(fullPath)
      .then(() => true)
      .catch(() => false)
    if (exists) dirs.push(fullPath)
  }
  return dirs
}

async function findAllStrategies(): Promise<
  Array<{
    name: string
    path: string
    size: number
    modified: Date
    hasClass: boolean
  }>
> {
  const strategies: Array<{
    name: string
    path: string
    size: number
    modified: Date
    hasClass: boolean
  }> = []

  const dirs = await findStrategyDirs()

  for (const dir of dirs) {
    const files = await fs.promises.readdir(dir)
    const pyFiles = files.filter((f) => f.endsWith(".py") && !f.startsWith("__"))

    for (const file of pyFiles) {
      const filePath = path.join(dir, file)
      const stats = await fs.promises.stat(filePath)
      const content = await fs.promises.readFile(filePath, "utf-8")

      // Check if file has a Strategy class
      const hasClass = /class\s+Strategy\s*[:(]/.test(content)

      strategies.push({
        name: file.replace(".py", ""),
        path: filePath,
        size: stats.size,
        modified: stats.mtime,
        hasClass,
      })
    }
  }

  // Sort by modified date (most recent first)
  strategies.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  return strategies
}

export const ListStrategiesBuildTool = Tool.define("list_strategies", async () => {
  return {
    description:
      "List all available strategy files in the strategies/ folder. Returns strategy names, file sizes, " +
      "modification dates, and whether they have a valid Strategy class. Use this to see what strategies " +
      "are available for editing, validation, or deployment.",
    parameters: z.object({
      valid_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only show strategies with a valid Strategy class"),
    }),
    async execute(params, ctx) {
      try {
        let strategies = await findAllStrategies()

        if (params.valid_only) {
          strategies = strategies.filter((s) => s.hasClass)
        }

        if (strategies.length === 0) {
          return {
            title: "Strategies",
            output: `No strategies found.

**Strategy directories searched:**
${STRATEGY_DIRS.map((d) => `- ${d}/`).join("\n")}

**Create a new strategy:**
Use the scaffold_strategy tool to generate a strategy template, or create a file manually in the strategies/ folder.

**Strategy interface:**
\`\`\`python
class Strategy:
    def __init__(self):
        pass

    def on_tick(self, bar: dict) -> str:
        # Return "BUY", "SELL", or "HOLD"
        return "HOLD"
\`\`\``,
            metadata: { count: 0, strategies: [] },
          }
        }

        const lines: string[] = []
        lines.push("# Available Strategies")
        lines.push("")

        // Group by validity
        const valid = strategies.filter((s) => s.hasClass)
        const invalid = strategies.filter((s) => !s.hasClass)

        if (valid.length > 0) {
          lines.push("## ✅ Valid Strategies (ready to deploy)")
          lines.push("")
          for (const s of valid) {
            const relPath = path.relative(Instance.directory, s.path)
            const date = s.modified.toISOString().split("T")[0]
            const sizeKb = (s.size / 1024).toFixed(1)
            lines.push(`- **${s.name}** - ${sizeKb}KB - modified ${date}`)
            lines.push(`  \`${relPath}\``)
          }
          lines.push("")
        }

        if (invalid.length > 0 && !params.valid_only) {
          lines.push("## ⚠️ Invalid/Incomplete Strategies")
          lines.push("")
          for (const s of invalid) {
            const relPath = path.relative(Instance.directory, s.path)
            lines.push(`- **${s.name}** - missing Strategy class`)
            lines.push(`  \`${relPath}\``)
          }
          lines.push("")
        }

        lines.push("---")
        lines.push(`**Total:** ${strategies.length} strategy file(s) (${valid.length} valid)`)
        lines.push("")
        lines.push("**Commands:**")
        lines.push("- Use `get_strategy_code` to view a strategy's code")
        lines.push("- Use `validate_strategy` to check for errors")
        lines.push("- Use `deploy_strategy` to deploy to the arena")

        return {
          title: "Strategies",
          output: lines.join("\n"),
          metadata: {
            count: strategies.length,
            valid_count: valid.length,
            strategies: strategies.map((s) => ({
              name: s.name,
              path: path.relative(Instance.directory, s.path),
              size: s.size,
              modified: s.modified.toISOString(),
              hasClass: s.hasClass,
            })),
          },
        }
      } catch (error: any) {
        return {
          title: "List Strategies Error",
          output: `Failed to list strategies: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const GetStrategyCodeTool = Tool.define("get_strategy_code", async () => {
  return {
    description:
      "Read and display the full code of a strategy file. Use this to review existing strategies " +
      "before editing, understand their logic, or as reference when building new strategies.",
    parameters: z.object({
      strategy_name: z
        .string()
        .describe("Name of the strategy (without .py extension, e.g., 'momentum' or 'buy_the_dip')"),
    }),
    async execute(params, ctx) {
      try {
        const strategies = await findAllStrategies()
        const strategy = strategies.find(
          (s) => s.name.toLowerCase() === params.strategy_name.toLowerCase()
        )

        if (!strategy) {
          const available = strategies.map((s) => s.name).join(", ")
          return {
            title: `Strategy Not Found: ${params.strategy_name}`,
            output: `Strategy "${params.strategy_name}" not found.

**Available strategies:**
${available || "None"}

**Tip:** Use list_strategies to see all available strategies.`,
            metadata: { error: "not_found", available: strategies.map((s) => s.name) },
          }
        }

        const code = await fs.promises.readFile(strategy.path, "utf-8")
        const relPath = path.relative(Instance.directory, strategy.path)
        const lines = code.split("\n").length

        const output = `# Strategy: ${strategy.name}

**File:** \`${relPath}\`
**Size:** ${(strategy.size / 1024).toFixed(1)}KB
**Lines:** ${lines}
**Valid:** ${strategy.hasClass ? "✅ Yes (has Strategy class)" : "⚠️ No (missing Strategy class)"}
**Modified:** ${strategy.modified.toISOString()}

---

\`\`\`python
${code}
\`\`\`

---

**Next steps:**
- Use \`validate_strategy\` to check for errors
- Use \`deploy_strategy\` to deploy to the arena
- Edit the file at \`${relPath}\` to modify the strategy`

        return {
          title: `Strategy: ${strategy.name}`,
          output,
          metadata: {
            name: strategy.name,
            path: relPath,
            size: strategy.size,
            lines,
            hasClass: strategy.hasClass,
            modified: strategy.modified.toISOString(),
          },
        }
      } catch (error: any) {
        return {
          title: "Get Strategy Error",
          output: `Failed to read strategy: ${error.message}`,
          metadata: { error: error.message },
        }
      }
    },
  }
})
