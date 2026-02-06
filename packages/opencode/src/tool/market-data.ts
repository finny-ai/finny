import { Tool } from "./tool"
import z from "zod"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

export const MarketPriceTool = Tool.define("get_market_price", async () => {
  return {
    description:
      "Get current market prices for trading symbols. Returns the latest price data for one or all available symbols. " +
      "Use this to check current market conditions before analyzing or trading.",
    parameters: z.object({
      symbol: z
        .string()
        .optional()
        .describe(
          "Specific symbol to get price for (e.g., 'BTC', 'ETH', 'AAPL'). If not provided, returns prices for all symbols."
        ),
    }),
    async execute(params, ctx) {
      try {
        const response = await fetch(`${SIMULATOR_URL}/prices`, {
          signal: ctx.abort,
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch prices: ${response.status}`)
        }

        const data = await response.json()
        const prices = data.prices || {}

        if (params.symbol) {
          const symbol = params.symbol.toUpperCase()
          const price = prices[symbol]

          if (!price) {
            return {
              title: `Price for ${symbol}`,
              output: `No price data available for ${symbol}. Available symbols: ${Object.keys(prices).join(", ")}`,
              metadata: {},
            }
          }

          const priceValue = typeof price === "object" ? price.close || price.price : price
          const formattedPrice =
            typeof price === "object"
              ? `${symbol}: $${priceValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Open: $${price.open?.toLocaleString() || "N/A"}
High: $${price.high?.toLocaleString() || "N/A"}
Low: $${price.low?.toLocaleString() || "N/A"}
Close: $${price.close?.toLocaleString() || "N/A"}
Volume: ${price.volume?.toLocaleString() || "N/A"}`
              : `${symbol}: $${priceValue.toLocaleString()}`

          return {
            title: `Price for ${symbol}`,
            output: formattedPrice,
            metadata: { symbol, price: priceValue },
          }
        }

        // Return all prices
        const priceList = Object.entries(prices)
          .map(([sym, p]: [string, any]) => {
            const value = typeof p === "object" ? p.close || p.price : p
            return `${sym}: $${value?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "N/A"}`
          })
          .join("\n")

        return {
          title: "Current Market Prices",
          output: priceList || "No price data available",
          metadata: { prices },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error
        return {
          title: "Market Price Error",
          output: `Failed to fetch market prices: ${error.message}. Make sure the simulator is running.`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const PriceHistoryTool = Tool.define("get_price_history", async () => {
  return {
    description:
      "Get historical OHLCV (Open, High, Low, Close, Volume) price data for a symbol. " +
      "Useful for analyzing price trends, calculating indicators, and backtesting strategy ideas.",
    parameters: z.object({
      symbol: z.string().describe("Trading symbol to get history for (e.g., 'BTC', 'ETH', 'AAPL')"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Number of historical bars to return (default 50, max 500)"),
    }),
    async execute(params, ctx) {
      const symbol = params.symbol.toUpperCase()
      const limit = Math.min(params.limit || 50, 500)

      try {
        const response = await fetch(`${SIMULATOR_URL}/history/${symbol}?limit=${limit}`, {
          signal: ctx.abort,
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch history: ${response.status}`)
        }

        const data = await response.json()
        const history = data.history || []

        if (history.length === 0) {
          return {
            title: `History for ${symbol}`,
            output: `No historical data available for ${symbol}`,
            metadata: {},
          }
        }

        // Format the data for display
        const latestBar = history[history.length - 1]
        const oldestBar = history[0]

        // Calculate some basic stats
        const closes = history.map((h: any) => h.close || h.price).filter(Boolean)
        const high = Math.max(...history.map((h: any) => h.high || h.close || 0))
        const low = Math.min(...history.map((h: any) => h.low || h.close || Infinity))
        const avgVolume = history.reduce((sum: number, h: any) => sum + (h.volume || 0), 0) / history.length

        const priceChange = closes.length >= 2 ? closes[closes.length - 1] - closes[0] : 0
        const priceChangePercent = closes[0] ? ((priceChange / closes[0]) * 100).toFixed(2) : "N/A"

        const output = `${symbol} Price History (${history.length} bars)

Latest: $${latestBar.close?.toLocaleString() || latestBar.price?.toLocaleString() || "N/A"}
Period High: $${high.toLocaleString()}
Period Low: $${low.toLocaleString()}
Change: ${priceChange >= 0 ? "+" : ""}$${priceChange.toFixed(2)} (${priceChangePercent}%)
Avg Volume: ${avgVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}

Recent bars (newest first):
${history
  .slice(-10)
  .reverse()
  .map((bar: any) => {
    const date = bar.timestamp ? new Date(bar.timestamp).toISOString().split("T")[0] : "N/A"
    return `  ${date}: O:${bar.open?.toFixed(2) || "N/A"} H:${bar.high?.toFixed(2) || "N/A"} L:${bar.low?.toFixed(2) || "N/A"} C:${bar.close?.toFixed(2) || "N/A"} V:${(bar.volume || 0).toLocaleString()}`
  })
  .join("\n")}`

        return {
          title: `History for ${symbol}`,
          output,
          metadata: {
            symbol,
            count: history.length,
            latest: latestBar,
            high,
            low,
            priceChange,
            priceChangePercent,
          },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error
        return {
          title: `History Error for ${symbol}`,
          output: `Failed to fetch price history: ${error.message}. Make sure the simulator is running.`,
          metadata: { error: error.message },
        }
      }
    },
  }
})
