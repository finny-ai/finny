import { Tool } from "./tool"
import z from "zod"

interface NewsCategory {
  id: string
  name: string
  description: string
  searchQueries: string[]
  symbols?: string[]
}

const NEWS_CATEGORIES: NewsCategory[] = [
  {
    id: "crypto",
    name: "Cryptocurrency News",
    description: "Latest news about Bitcoin, Ethereum, and the broader crypto market",
    searchQueries: [
      "Bitcoin BTC price news today",
      "Ethereum ETH news analysis",
      "cryptocurrency market news",
      "crypto regulation news",
      "DeFi news updates",
    ],
    symbols: ["BTC", "ETH", "SOL"],
  },
  {
    id: "stocks",
    name: "Stock Market News",
    description: "News about major tech stocks and market movements",
    searchQueries: [
      "stock market news today",
      "NASDAQ tech stocks news",
      "S&P 500 market update",
      "tech sector earnings news",
    ],
    symbols: ["AAPL", "MSFT", "GOOGL", "NVDA", "TSLA", "AMZN", "META"],
  },
  {
    id: "earnings",
    name: "Earnings Reports",
    description: "Upcoming and recent earnings announcements",
    searchQueries: [
      "tech earnings report this week",
      "NVDA AAPL earnings expectations",
      "quarterly earnings calendar tech",
      "earnings surprise stock reaction",
    ],
  },
  {
    id: "regulations",
    name: "Regulatory News",
    description: "Government and regulatory updates affecting markets",
    searchQueries: [
      "SEC crypto regulation news",
      "Federal Reserve interest rate news",
      "financial regulation updates",
      "cryptocurrency policy news",
    ],
  },
  {
    id: "macro",
    name: "Macroeconomic News",
    description: "Broader economic indicators and trends",
    searchQueries: [
      "inflation economic data today",
      "GDP economic growth news",
      "employment jobs report",
      "economic outlook forecast",
    ],
  },
  {
    id: "ai",
    name: "AI & Technology",
    description: "News about AI developments affecting tech stocks",
    searchQueries: [
      "AI artificial intelligence stock news",
      "NVIDIA AI chip demand",
      "Microsoft OpenAI news",
      "AI technology investment news",
    ],
  },
]

export const ChatNewsTool = Tool.define("get_news_guidance", async () => {
  return {
    description:
      "Get guidance on finding relevant trading news. Returns curated search suggestions organized by category " +
      "(crypto, stocks, earnings, regulations, etc.) that you can use with the WebSearch tool to find " +
      "current market news and analysis.",
    parameters: z.object({
      category: z
        .enum(["all", "crypto", "stocks", "earnings", "regulations", "macro", "ai"])
        .optional()
        .default("all")
        .describe("News category to focus on"),
      symbol: z
        .string()
        .optional()
        .describe("Specific symbol to get news suggestions for (e.g., BTC, AAPL)"),
    }),
    async execute(params, ctx) {
      const lines: string[] = []
      lines.push("# News Search Guidance")
      lines.push("")

      // If specific symbol requested
      if (params.symbol) {
        const symbol = params.symbol.toUpperCase()
        const isCrypto = ["BTC", "ETH", "SOL"].includes(symbol)

        lines.push(`## News for ${symbol}`)
        lines.push("")
        lines.push("**Recommended searches:**")
        lines.push("")

        const symbolQueries = [
          `${symbol} stock price news today`,
          `${symbol} ${isCrypto ? "crypto" : "company"} latest analysis`,
          `${symbol} technical analysis forecast`,
          `${symbol} ${isCrypto ? "blockchain" : "earnings"} news`,
          `${symbol} market sentiment analysis`,
        ]

        for (const query of symbolQueries) {
          lines.push(`- \`${query}\``)
        }

        lines.push("")
        lines.push("**How to use:**")
        lines.push("Ask me to search for any of these queries, or I can use the WebSearch tool directly.")
        lines.push("")
        lines.push("Example: \"Search for the latest NVDA earnings news\"")

        return {
          title: "News Guidance",
          output: lines.join("\n"),
          metadata: {
            symbol,
            queries: symbolQueries,
            category: isCrypto ? "crypto" : "stocks",
          },
        }
      }

      // Get categories to show
      let categoriesToShow: NewsCategory[]
      if (params.category === "all") {
        categoriesToShow = NEWS_CATEGORIES
      } else {
        categoriesToShow = NEWS_CATEGORIES.filter((c) => c.id === params.category)
      }

      lines.push("Use these search suggestions to find relevant trading news.")
      lines.push("I can search for any of these topics using the WebSearch tool.")
      lines.push("")

      for (const category of categoriesToShow) {
        lines.push(`## ${category.name}`)
        lines.push(`*${category.description}*`)
        lines.push("")

        if (category.symbols) {
          lines.push(`**Relevant symbols:** ${category.symbols.join(", ")}`)
          lines.push("")
        }

        lines.push("**Search suggestions:**")
        for (const query of category.searchQueries) {
          lines.push(`- \`${query}\``)
        }
        lines.push("")
      }

      lines.push("---")
      lines.push("## How to Use")
      lines.push("")
      lines.push("1. **Ask me to search**: \"Search for Bitcoin price news today\"")
      lines.push("2. **Get symbol-specific news**: \"Get news guidance for NVDA\"")
      lines.push("3. **Focus on a category**: \"What's the latest earnings news?\"")
      lines.push("")
      lines.push("I'll use the WebSearch tool to find and summarize relevant articles for you.")

      return {
        title: "News Guidance",
        output: lines.join("\n"),
        metadata: {
          categories: categoriesToShow.map((c) => c.id),
          total_queries: categoriesToShow.reduce((sum, c) => sum + c.searchQueries.length, 0),
        },
      }
    },
  }
})
