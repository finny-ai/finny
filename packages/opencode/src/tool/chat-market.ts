import { Tool } from "./tool"
import z from "zod"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface PriceData {
  symbol: string
  price: number
  change_24h?: number
  change_percent_24h?: number
  volume_24h?: number
  high_24h?: number
  low_24h?: number
  timestamp: string
}

interface PricesResponse {
  prices: Record<string, PriceData>
  timestamp: string
}

const CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL"]
const STOCK_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "NVDA", "TSLA", "AMZN", "META"]

export const ChatMarketTool = Tool.define("get_market_overview", async () => {
  return {
    description:
      "Get a comprehensive overview of current market conditions. Returns prices for all available assets " +
      "categorized by crypto and stocks, including 24h changes and trading volume. Use this to understand " +
      "the current market environment before making trading decisions.",
    parameters: z.object({
      category: z
        .enum(["all", "crypto", "stocks"])
        .optional()
        .default("all")
        .describe("Filter by asset category"),
      symbols: z
        .array(z.string())
        .optional()
        .describe("Specific symbols to include (overrides category filter)"),
    }),
    async execute(params, ctx) {
      try {
        const response = await fetch(`${SIMULATOR_URL}/prices`)

        if (!response.ok) {
          return {
            title: "Market Overview",
            output: `Unable to fetch market data. Is the simulator running? (Status: ${response.status})`,
            metadata: { error: true, status: response.status },
          }
        }

        const data: PricesResponse = await response.json()
        const prices = data.prices || {}

        // Determine which symbols to show
        let symbolsToShow: string[]
        if (params.symbols && params.symbols.length > 0) {
          symbolsToShow = params.symbols.map((s) => s.toUpperCase())
        } else if (params.category === "crypto") {
          symbolsToShow = CRYPTO_SYMBOLS
        } else if (params.category === "stocks") {
          symbolsToShow = STOCK_SYMBOLS
        } else {
          symbolsToShow = [...CRYPTO_SYMBOLS, ...STOCK_SYMBOLS]
        }

        // Filter available prices
        const availablePrices: PriceData[] = []
        for (const symbol of symbolsToShow) {
          if (prices[symbol]) {
            availablePrices.push({ symbol, ...prices[symbol] })
          }
        }

        if (availablePrices.length === 0) {
          return {
            title: "Market Overview",
            output: `No price data available for requested symbols.

Available symbols:
- Crypto: ${CRYPTO_SYMBOLS.join(", ")}
- Stocks: ${STOCK_SYMBOLS.join(", ")}`,
            metadata: { available_symbols: { crypto: CRYPTO_SYMBOLS, stocks: STOCK_SYMBOLS } },
          }
        }

        // Categorize prices
        const cryptoPrices = availablePrices.filter((p) => CRYPTO_SYMBOLS.includes(p.symbol))
        const stockPrices = availablePrices.filter((p) => STOCK_SYMBOLS.includes(p.symbol))

        // Calculate market summary
        const gainers = availablePrices
          .filter((p) => (p.change_percent_24h || 0) > 0)
          .sort((a, b) => (b.change_percent_24h || 0) - (a.change_percent_24h || 0))
          .slice(0, 3)

        const losers = availablePrices
          .filter((p) => (p.change_percent_24h || 0) < 0)
          .sort((a, b) => (a.change_percent_24h || 0) - (b.change_percent_24h || 0))
          .slice(0, 3)

        // Build output
        const lines: string[] = []
        lines.push("# Market Overview")
        lines.push("")
        lines.push(`*Last updated: ${data.timestamp || new Date().toISOString()}*`)
        lines.push("")

        // Market sentiment summary
        const avgChange =
          availablePrices.reduce((sum, p) => sum + (p.change_percent_24h || 0), 0) / availablePrices.length
        const sentiment = avgChange > 1 ? "bullish" : avgChange < -1 ? "bearish" : "neutral"
        lines.push(`## Market Sentiment: ${sentiment.toUpperCase()}`)
        lines.push(`Average 24h change: ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(2)}%`)
        lines.push("")

        // Top movers
        if (gainers.length > 0 || losers.length > 0) {
          lines.push("## Top Movers")
          if (gainers.length > 0) {
            lines.push("**Gainers:**")
            for (const p of gainers) {
              lines.push(`- ${p.symbol}: +${(p.change_percent_24h || 0).toFixed(2)}%`)
            }
          }
          if (losers.length > 0) {
            lines.push("**Losers:**")
            for (const p of losers) {
              lines.push(`- ${p.symbol}: ${(p.change_percent_24h || 0).toFixed(2)}%`)
            }
          }
          lines.push("")
        }

        // Crypto section
        if (cryptoPrices.length > 0 && params.category !== "stocks") {
          lines.push("## Cryptocurrency")
          lines.push("")
          lines.push("| Symbol | Price | 24h Change | Volume |")
          lines.push("|--------|-------|------------|--------|")
          for (const p of cryptoPrices) {
            const changeStr = p.change_percent_24h
              ? `${p.change_percent_24h >= 0 ? "+" : ""}${p.change_percent_24h.toFixed(2)}%`
              : "N/A"
            const volumeStr = p.volume_24h
              ? `$${(p.volume_24h / 1e9).toFixed(2)}B`
              : "N/A"
            lines.push(
              `| ${p.symbol} | $${p.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${changeStr} | ${volumeStr} |`
            )
          }
          lines.push("")
        }

        // Stocks section
        if (stockPrices.length > 0 && params.category !== "crypto") {
          lines.push("## Stocks")
          lines.push("")
          lines.push("| Symbol | Price | 24h Change | High/Low |")
          lines.push("|--------|-------|------------|----------|")
          for (const p of stockPrices) {
            const changeStr = p.change_percent_24h
              ? `${p.change_percent_24h >= 0 ? "+" : ""}${p.change_percent_24h.toFixed(2)}%`
              : "N/A"
            const rangeStr =
              p.high_24h && p.low_24h
                ? `$${p.low_24h.toFixed(2)}-$${p.high_24h.toFixed(2)}`
                : "N/A"
            lines.push(
              `| ${p.symbol} | $${p.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${changeStr} | ${rangeStr} |`
            )
          }
          lines.push("")
        }

        lines.push("---")
        lines.push("Use `/price` for real-time price updates or ask me to analyze specific assets.")

        return {
          title: "Market Overview",
          output: lines.join("\n"),
          metadata: {
            sentiment,
            avg_change: avgChange,
            crypto_count: cryptoPrices.length,
            stock_count: stockPrices.length,
            gainers: gainers.map((p) => p.symbol),
            losers: losers.map((p) => p.symbol),
            timestamp: data.timestamp,
          },
        }
      } catch (error: any) {
        return {
          title: "Market Overview Error",
          output: `Failed to fetch market data: ${error.message}

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
