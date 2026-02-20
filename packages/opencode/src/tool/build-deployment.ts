import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"
const STRATEGY_DIRS = ["strategies", "packages/opencode/strategies"]

async function findStrategyFile(name: string): Promise<string | null> {
  for (const dir of STRATEGY_DIRS) {
    const fullPath = path.join(Instance.directory, dir, `${name}.py`)
    const exists = await fs.promises
      .access(fullPath)
      .then(() => true)
      .catch(() => false)
    if (exists) return fullPath
  }
  return null
}

export const DeployStrategyTool = Tool.define("deploy_strategy", async () => {
  return {
    description:
      "Deploy a trading strategy to the AlgoClash simulator arena. The strategy will start trading " +
      "immediately with simulated funds. Use validate_strategy first to check for errors. " +
      "Accepts either a strategy name (reads from file) or inline code.",
    parameters: z.object({
      strategy_name: z
        .string()
        .describe("Name of the strategy to deploy (without .py extension, e.g., 'momentum')"),
      code: z
        .string()
        .optional()
        .describe("Inline Python code to deploy (alternative to reading from file)"),
      symbol: z
        .string()
        .optional()
        .default("BTC")
        .describe("Trading symbol (e.g., 'BTC', 'ETH', 'AAPL'). Default: BTC"),
      initial_equity: z
        .number()
        .optional()
        .default(10000)
        .describe("Starting capital for the strategy. Default: 10000"),
      username: z
        .string()
        .optional()
        .describe("Username to associate with this strategy"),
    }),
    async execute(params, ctx): Promise<{title: string; output: string; metadata: Record<string, any>}> {
      try {
        let code: string
        let source: string

        if (params.code) {
          code = params.code
          source = "inline code"
        } else {
          const filePath = await findStrategyFile(params.strategy_name)
          if (!filePath) {
            return {
              title: "Deployment Failed",
              output: `Strategy file "${params.strategy_name}.py" not found.

**Search paths:**
${STRATEGY_DIRS.map((d) => `- ${d}/`).join("\n")}

Use list_strategies to see available strategies, or use scaffold_strategy to create one.`,
              metadata: { deployed: false, error: "file_not_found" },
            }
          }
          code = await fs.promises.readFile(filePath, "utf-8")
          source = filePath
        }

        // Deploy to simulator
        const deployPayload = {
          name: params.strategy_name,
          code,
          symbol: params.symbol?.toUpperCase() || "BTC",
          initial_equity: params.initial_equity || 10000,
          username: params.username,
        }

        const response = await fetch(`${SIMULATOR_URL}/deploy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deployPayload),
          signal: ctx.abort,
        })

        const data = await response.json()

        if (!response.ok) {
          const errorMsg = data.error || data.message || `HTTP ${response.status}`

          // Check for common errors and provide helpful messages
          if (errorMsg.includes("already deployed") || errorMsg.includes("already exists")) {
            return {
              title: "Deployment Failed",
              output: `Strategy "${params.strategy_name}" is already deployed.

**Options:**
1. Stop the existing strategy first: use \`stop_strategy\`
2. Use a different name for this deployment
3. Check strategy status with /strategy-status`,
              metadata: { deployed: false, error: "already_deployed" },
            }
          }

          return {
            title: "Deployment Failed",
            output: `Failed to deploy strategy: ${errorMsg}

**Troubleshooting:**
- Use \`validate_strategy\` to check for code errors
- Make sure the simulator is running at ${SIMULATOR_URL}
- Check that the strategy has a valid Strategy class with on_tick method`,
            metadata: { deployed: false, error: errorMsg },
          }
        }

        const strategyId = data.strategy_id || data.id || params.strategy_name
        const equity = data.initial_equity || params.initial_equity || 10000

        return {
          title: "Strategy Deployed ✅",
          output: `Strategy "${params.strategy_name}" deployed successfully!

**Details:**
- **Strategy ID:** ${strategyId}
- **Symbol:** ${params.symbol?.toUpperCase() || "BTC"}
- **Initial Equity:** $${equity.toLocaleString()}
- **Source:** ${source}
${params.username ? `- **User:** ${params.username}` : ""}

**Next steps:**
- Monitor performance: /strategy-status or /ss
- View live trades: /deploy → Watch
- Stop the strategy: use \`stop_strategy\`

The strategy is now live and trading in the arena! 🚀`,
          metadata: {
            deployed: true,
            strategyId,
            name: params.strategy_name,
            symbol: params.symbol?.toUpperCase() || "BTC",
            initialEquity: equity,
            source,
            response: data,
          },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error

        if (error.message.includes("ECONNREFUSED") || error.message.includes("fetch failed")) {
          return {
            title: "Deployment Failed",
            output: `Cannot connect to simulator at ${SIMULATOR_URL}.

**Make sure the simulator is running:**
\`\`\`bash
cd simulator
python main.py
\`\`\`

Or set the FINNY_SIMULATOR_URL environment variable to point to your simulator.`,
            metadata: { deployed: false, error: "connection_refused" },
          }
        }

        return {
          title: "Deployment Error",
          output: `Deployment failed: ${error.message}`,
          metadata: { deployed: false, error: error.message },
        }
      }
    },
  }
})

export const StopStrategyTool = Tool.define("stop_strategy", async () => {
  return {
    description:
      "Stop a running strategy in the AlgoClash simulator. Returns the final performance stats and P&L. " +
      "Use this to remove a strategy from the arena.",
    parameters: z.object({
      strategy_name: z
        .string()
        .describe("Name of the strategy to stop"),
    }),
    async execute(params, ctx): Promise<{title: string; output: string; metadata: Record<string, any>}> {
      try {
        // First get the current stats
        let finalStats: any = null
        try {
          const statsResponse = await fetch(`${SIMULATOR_URL}/agent/${params.strategy_name}/stats`, {
            signal: ctx.abort,
          })
          if (statsResponse.ok) {
            finalStats = await statsResponse.json()
          }
        } catch (e) {
          // Stats fetch failed, continue with stop
        }

        // Stop the strategy
        const response = await fetch(`${SIMULATOR_URL}/agent/${params.strategy_name}`, {
          method: "DELETE",
          signal: ctx.abort,
        })

        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          const errorMsg = data.error || data.message || `HTTP ${response.status}`

          if (response.status === 404 || errorMsg.includes("not found")) {
            return {
              title: "Strategy Not Found",
              output: `Strategy "${params.strategy_name}" is not currently running.

**Check running strategies:**
- Use /strategy-status to see all running strategies
- Use list_strategies to see available strategy files`,
              metadata: { stopped: false, error: "not_found" },
            }
          }

          return {
            title: "Stop Failed",
            output: `Failed to stop strategy: ${errorMsg}`,
            metadata: { stopped: false, error: errorMsg },
          }
        }

        // Build final report
        const lines: string[] = []
        lines.push(`# Strategy Stopped: ${params.strategy_name}`)
        lines.push("")

        if (finalStats) {
          const pnl = finalStats.pnl || finalStats.profit_loss || 0
          const pnlPercent = finalStats.pnl_percent || finalStats.roi || 0
          const trades = finalStats.total_trades || finalStats.trades || 0
          const winRate = finalStats.win_rate || 0
          const equity = finalStats.equity || finalStats.current_equity || 0

          lines.push("## Final Performance")
          lines.push("")
          lines.push(`- **Final Equity:** $${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}`)
          lines.push(`- **P&L:** ${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%)`)
          lines.push(`- **Total Trades:** ${trades}`)
          if (trades > 0) {
            lines.push(`- **Win Rate:** ${(winRate * 100).toFixed(1)}%`)
          }
          lines.push("")
        }

        lines.push("The strategy has been removed from the arena.")
        lines.push("")
        lines.push("**Next steps:**")
        lines.push("- Use `deploy_strategy` to redeploy with modifications")
        lines.push("- Use `list_strategies` to see available strategies")

        return {
          title: `Strategy Stopped: ${params.strategy_name}`,
          output: lines.join("\n"),
          metadata: {
            stopped: true,
            name: params.strategy_name,
            finalStats,
          },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error

        if (error.message.includes("ECONNREFUSED") || error.message.includes("fetch failed")) {
          return {
            title: "Stop Failed",
            output: `Cannot connect to simulator at ${SIMULATOR_URL}. Make sure the simulator is running.`,
            metadata: { stopped: false, error: "connection_refused" },
          }
        }

        return {
          title: "Stop Error",
          output: `Failed to stop strategy: ${error.message}`,
          metadata: { stopped: false, error: error.message },
        }
      }
    },
  }
})
