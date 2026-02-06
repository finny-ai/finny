import { Tool } from "./tool"
import z from "zod"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface StrategyStatus {
  name: string
  symbol: string
  equity: number
  initial_equity: number
  cash: number
  position: number
  trades: number
  wins: number
  losses: number
  pnl: number
  roi: number
  max_drawdown: number
  sharpe_ratio: number
  status: "running" | "stopped" | "error"
}

interface StatusResponse {
  strategies: StrategyStatus[]
  total_equity: number
  total_pnl: number
  timestamp: string
}

export const ChatPortfolioTool = Tool.define("get_portfolio_summary", async () => {
  return {
    description:
      "Get a comprehensive overview of your trading portfolio. Returns total equity, P&L, ROI, active positions, " +
      "and trade statistics across all deployed strategies. Use this to understand your current portfolio state.",
    parameters: z.object({
      include_stopped: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include stopped strategies in the summary"),
    }),
    async execute(params, ctx) {
      try {
        const response = await fetch(`${SIMULATOR_URL}/status`)

        if (!response.ok) {
          return {
            title: "Portfolio Summary",
            output: `Unable to fetch portfolio data. Is the simulator running? (Status: ${response.status})`,
            metadata: { error: true, status: response.status },
          }
        }

        const data: StatusResponse = await response.json()

        // Filter strategies based on params
        let strategies = data.strategies || []
        if (!params.include_stopped) {
          strategies = strategies.filter((s) => s.status === "running")
        }

        if (strategies.length === 0) {
          return {
            title: "Portfolio Summary",
            output: `No active strategies found.

To deploy a strategy:
1. Use /deploy to select and deploy a strategy
2. Or ask me to help you create a new strategy

The simulator is running and ready to accept strategies.`,
            metadata: {
              total_strategies: 0,
              total_equity: 0,
              total_pnl: 0,
            },
          }
        }

        // Calculate aggregate statistics
        const totalEquity = strategies.reduce((sum, s) => sum + s.equity, 0)
        const totalInitialEquity = strategies.reduce((sum, s) => sum + s.initial_equity, 0)
        const totalPnL = strategies.reduce((sum, s) => sum + s.pnl, 0)
        const totalTrades = strategies.reduce((sum, s) => sum + s.trades, 0)
        const totalWins = strategies.reduce((sum, s) => sum + s.wins, 0)
        const totalLosses = strategies.reduce((sum, s) => sum + s.losses, 0)
        const overallROI = totalInitialEquity > 0 ? ((totalEquity - totalInitialEquity) / totalInitialEquity) * 100 : 0
        const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0

        // Group strategies by symbol
        const bySymbol: Record<string, StrategyStatus[]> = {}
        for (const s of strategies) {
          if (!bySymbol[s.symbol]) bySymbol[s.symbol] = []
          bySymbol[s.symbol].push(s)
        }

        // Build detailed output
        const lines: string[] = []
        lines.push("# Portfolio Summary")
        lines.push("")
        lines.push("## Overall Performance")
        lines.push(`- **Total Equity:** $${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
        lines.push(`- **Total P&L:** ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
        lines.push(`- **Overall ROI:** ${overallROI >= 0 ? "+" : ""}${overallROI.toFixed(2)}%`)
        lines.push(`- **Active Strategies:** ${strategies.length}`)
        lines.push("")
        lines.push("## Trading Statistics")
        lines.push(`- **Total Trades:** ${totalTrades}`)
        lines.push(`- **Win Rate:** ${winRate.toFixed(1)}% (${totalWins}W / ${totalLosses}L)`)
        lines.push("")
        lines.push("## Strategies by Symbol")

        for (const [symbol, symbolStrategies] of Object.entries(bySymbol)) {
          const symbolEquity = symbolStrategies.reduce((sum, s) => sum + s.equity, 0)
          const symbolPnL = symbolStrategies.reduce((sum, s) => sum + s.pnl, 0)
          const symbolPosition = symbolStrategies.reduce((sum, s) => sum + s.position, 0)

          lines.push("")
          lines.push(`### ${symbol}`)
          lines.push(`- Equity: $${symbolEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
          lines.push(`- P&L: ${symbolPnL >= 0 ? "+" : ""}$${symbolPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
          lines.push(`- Net Position: ${symbolPosition}`)

          for (const s of symbolStrategies) {
            lines.push(`  - **${s.name}**: ROI ${s.roi >= 0 ? "+" : ""}${s.roi.toFixed(2)}%, ${s.trades} trades`)
          }
        }

        lines.push("")
        lines.push("---")
        lines.push(`*Last updated: ${data.timestamp || new Date().toISOString()}*`)

        return {
          title: "Portfolio Summary",
          output: lines.join("\n"),
          metadata: {
            total_strategies: strategies.length,
            total_equity: totalEquity,
            total_pnl: totalPnL,
            overall_roi: overallROI,
            total_trades: totalTrades,
            win_rate: winRate,
            by_symbol: bySymbol,
            timestamp: data.timestamp,
          },
        }
      } catch (error: any) {
        return {
          title: "Portfolio Summary Error",
          output: `Failed to fetch portfolio data: ${error.message}

Make sure the trading simulator is running:
\`\`\`bash
python simulator/main.py
\`\`\``,
          metadata: { error: error.message },
        }
      }
    },
  }
})
