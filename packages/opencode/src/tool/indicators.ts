import { Tool } from "./tool"
import z from "zod"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

export const CalculateIndicatorTool = Tool.define("calculate_indicator", async () => {
  return {
    description:
      "Calculate technical indicators for a trading symbol. Supports RSI, MACD, Bollinger Bands, volatility, SMA, and EMA. " +
      "Use this to analyze market conditions and identify trading signals.",
    parameters: z.object({
      symbol: z.string().describe("Trading symbol to analyze (e.g., 'BTC', 'ETH', 'AAPL')"),
      indicator: z
        .enum(["rsi", "macd", "bollinger", "volatility", "sma", "ema", "all"])
        .describe("Indicator to calculate: rsi, macd, bollinger, volatility, sma, ema, or all"),
      period: z
        .number()
        .optional()
        .describe(
          "Indicator period. Defaults vary by indicator: RSI=14, MACD uses fast/slow/signal, Bollinger=20, Volatility=20, SMA/EMA=20"
        ),
      // MACD-specific parameters
      fast: z.number().optional().describe("MACD fast EMA period (default 12)"),
      slow: z.number().optional().describe("MACD slow EMA period (default 26)"),
      signal: z.number().optional().describe("MACD signal line period (default 9)"),
      // Bollinger-specific parameters
      std: z.number().optional().describe("Bollinger Bands standard deviation multiplier (default 2.0)"),
    }),
    async execute(params, ctx) {
      const symbol = params.symbol.toUpperCase()
      const indicator = params.indicator

      try {
        let url: string
        const queryParams = new URLSearchParams()

        switch (indicator) {
          case "rsi":
            url = `${SIMULATOR_URL}/indicators/${symbol}/rsi`
            if (params.period) queryParams.set("period", params.period.toString())
            break

          case "macd":
            url = `${SIMULATOR_URL}/indicators/${symbol}/macd`
            if (params.fast) queryParams.set("fast", params.fast.toString())
            if (params.slow) queryParams.set("slow", params.slow.toString())
            if (params.signal) queryParams.set("signal", params.signal.toString())
            break

          case "bollinger":
            url = `${SIMULATOR_URL}/indicators/${symbol}/bollinger`
            if (params.period) queryParams.set("period", params.period.toString())
            if (params.std) queryParams.set("std", params.std.toString())
            break

          case "volatility":
            url = `${SIMULATOR_URL}/indicators/${symbol}/volatility`
            if (params.period) queryParams.set("period", params.period.toString())
            break

          case "sma":
            url = `${SIMULATOR_URL}/indicators/${symbol}/sma`
            if (params.period) queryParams.set("period", params.period.toString())
            break

          case "ema":
            url = `${SIMULATOR_URL}/indicators/${symbol}/ema`
            if (params.period) queryParams.set("period", params.period.toString())
            break

          case "all":
            url = `${SIMULATOR_URL}/indicators/${symbol}/all`
            break

          default:
            return {
              title: "Invalid Indicator",
              output: `Unknown indicator: ${indicator}. Valid options: rsi, macd, bollinger, volatility, sma, ema, all`,
              metadata: {},
            }
        }

        const queryString = queryParams.toString()
        if (queryString) url += `?${queryString}`

        const response = await fetch(url, { signal: ctx.abort })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || `Failed to calculate indicator: ${response.status}`)
        }

        const data = await response.json()

        // Format output based on indicator type
        let output: string

        if (indicator === "all") {
          output = formatAllIndicators(symbol, data)
        } else if (indicator === "rsi") {
          output = formatRSI(symbol, data)
        } else if (indicator === "macd") {
          output = formatMACD(symbol, data)
        } else if (indicator === "bollinger") {
          output = formatBollinger(symbol, data)
        } else if (indicator === "volatility") {
          output = formatVolatility(symbol, data)
        } else if (indicator === "sma" || indicator === "ema") {
          output = formatMA(symbol, indicator.toUpperCase(), data)
        } else {
          output = JSON.stringify(data, null, 2)
        }

        return {
          title: `${indicator.toUpperCase()} for ${symbol}`,
          output,
          metadata: { symbol, indicator, ...data },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error
        return {
          title: `Indicator Error for ${symbol}`,
          output: `Failed to calculate ${indicator}: ${error.message}. Make sure the simulator is running.`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

export const CalculateCorrelationTool = Tool.define("calculate_correlation", async () => {
  return {
    description:
      "Calculate the correlation coefficient between two trading symbols. " +
      "Useful for identifying pairs trading opportunities and portfolio diversification.",
    parameters: z.object({
      symbol_a: z.string().describe("First trading symbol (e.g., 'BTC')"),
      symbol_b: z.string().describe("Second trading symbol (e.g., 'ETH')"),
      period: z.number().optional().describe("Lookback period (optional, uses all available data if not specified)"),
    }),
    async execute(params, ctx) {
      const symbolA = params.symbol_a.toUpperCase()
      const symbolB = params.symbol_b.toUpperCase()

      try {
        let url = `${SIMULATOR_URL}/indicators/correlation?a=${symbolA}&b=${symbolB}`
        if (params.period) url += `&period=${params.period}`

        const response = await fetch(url, { signal: ctx.abort })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || `Failed to calculate correlation: ${response.status}`)
        }

        const data = await response.json()

        const correlation = data.correlation
        const interpretation = data.interpretation?.replace(/_/g, " ") || "unknown"

        const output = `Correlation: ${symbolA} vs ${symbolB}

Coefficient: ${correlation?.toFixed(4) || "N/A"}
Interpretation: ${interpretation}
Data Points: ${data.data_points || "N/A"}

${getCorrelationExplanation(correlation)}`

        return {
          title: `Correlation: ${symbolA} vs ${symbolB}`,
          output,
          metadata: { symbolA, symbolB, ...data },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error
        return {
          title: `Correlation Error`,
          output: `Failed to calculate correlation: ${error.message}. Make sure the simulator is running.`,
          metadata: { error: error.message },
        }
      }
    },
  }
})

// Helper formatting functions

function formatRSI(symbol: string, data: any): string {
  const rsi = data.rsi
  const signal = data.signal?.replace(/_/g, " ") || "neutral"

  return `RSI Analysis for ${symbol}

Current RSI: ${rsi?.toFixed(2) || "N/A"}
Signal: ${signal.toUpperCase()}
Period: ${data.period || 14}

Interpretation:
${rsi >= 70 ? "- RSI is OVERBOUGHT (>=70). Consider taking profits or preparing for a pullback." : rsi <= 30 ? "- RSI is OVERSOLD (<=30). Watch for potential bounce or reversal." : "- RSI is NEUTRAL. No extreme conditions detected."}`
}

function formatMACD(symbol: string, data: any): string {
  const macd = data.macd
  const signal = data.signal
  const histogram = data.histogram
  const trend = data.trend?.replace(/_/g, " ") || "neutral"
  const crossover = data.crossover

  return `MACD Analysis for ${symbol}

MACD Line: ${macd?.toFixed(4) || "N/A"}
Signal Line: ${signal?.toFixed(4) || "N/A"}
Histogram: ${histogram?.toFixed(4) || "N/A"}
Trend: ${trend.toUpperCase()}
${crossover ? `Recent Crossover: ${crossover.toUpperCase()}` : "No recent crossover"}

Parameters: Fast=${data.params?.fast || 12}, Slow=${data.params?.slow || 26}, Signal=${data.params?.signal || 9}

Interpretation:
${macd > signal ? "- MACD is above signal line - BULLISH momentum" : macd < signal ? "- MACD is below signal line - BEARISH momentum" : "- MACD is at signal line - no clear momentum"}
${crossover === "bullish" ? "- Recent BULLISH crossover detected - potential BUY signal" : crossover === "bearish" ? "- Recent BEARISH crossover detected - potential SELL signal" : ""}`
}

function formatBollinger(symbol: string, data: any): string {
  const upper = data.upper
  const middle = data.middle
  const lower = data.lower
  const bandwidth = data.bandwidth
  const percentB = data.percent_b
  const position = data.position?.replace(/_/g, " ") || "middle"
  const currentPrice = data.current_price

  return `Bollinger Bands Analysis for ${symbol}

Upper Band: $${upper?.toFixed(2) || "N/A"}
Middle Band (SMA): $${middle?.toFixed(2) || "N/A"}
Lower Band: $${lower?.toFixed(2) || "N/A"}
Current Price: $${currentPrice?.toFixed(2) || "N/A"}
Position: ${position.toUpperCase()}
%B: ${percentB?.toFixed(4) || "N/A"} ${percentB > 1 ? "(above bands)" : percentB < 0 ? "(below bands)" : "(within bands)"}
Bandwidth: ${bandwidth?.toFixed(2) || "N/A"}%

Parameters: Period=${data.params?.period || 20}, StdDev=${data.params?.std_dev || 2}

Interpretation:
${position === "above upper" ? "- Price is ABOVE upper band - potential overbought condition or strong breakout" : position === "below lower" ? "- Price is BELOW lower band - potential oversold condition or breakdown" : position === "upper half" ? "- Price is in upper half of bands - bullish bias" : position === "lower half" ? "- Price is in lower half of bands - bearish bias" : "- Price is at middle band"}
${bandwidth && bandwidth < 5 ? "- LOW bandwidth suggests consolidation - breakout may be coming" : bandwidth && bandwidth > 15 ? "- HIGH bandwidth suggests volatility - use wider stops" : ""}`
}

function formatVolatility(symbol: string, data: any): string {
  const vol = data.volatility
  const annualized = data.annualized
  const annualizedPercent = data.annualized_percent
  const level = data.level?.replace(/_/g, " ") || "normal"

  return `Volatility Analysis for ${symbol}

Daily Volatility: ${vol?.toFixed(6) || "N/A"}
Annualized Volatility: ${annualized?.toFixed(4) || "N/A"} (${annualizedPercent?.toFixed(2) || "N/A"}%)
Level: ${level.toUpperCase()}
Period: ${data.period || 20}

Interpretation:
${level === "very high" ? "- VERY HIGH volatility (>50% annualized) - use extreme caution and wider stops" : level === "high" ? "- HIGH volatility (>30% annualized) - consider reducing position size" : level === "low" ? "- LOW volatility (<10% annualized) - potential for breakout move" : "- NORMAL volatility - standard risk management applies"}`
}

function formatMA(symbol: string, type: string, data: any): string {
  const value = type === "SMA" ? data.sma : data.ema
  const period = data.period

  return `${type} Analysis for ${symbol}

Current ${type}(${period}): $${value?.toFixed(2) || "N/A"}

Use this value to:
- Compare with current price for trend direction
- Identify support/resistance levels
- Combine with other ${type}s for crossover strategies`
}

function formatAllIndicators(symbol: string, data: any): string {
  const currentPrice = data.current_price

  return `Complete Technical Analysis for ${symbol}

Current Price: $${currentPrice?.toFixed(2) || "N/A"}
Data Points: ${data.data_points || "N/A"}

--- RSI ---
Value: ${data.rsi?.rsi?.toFixed(2) || "N/A"}
Signal: ${data.rsi?.signal?.toUpperCase() || "N/A"}

--- MACD ---
MACD: ${data.macd?.macd?.toFixed(4) || "N/A"}
Signal: ${data.macd?.signal?.toFixed(4) || "N/A"}
Histogram: ${data.macd?.histogram?.toFixed(4) || "N/A"}
Trend: ${data.macd?.trend?.toUpperCase() || "N/A"}

--- Bollinger Bands ---
Upper: $${data.bollinger?.upper?.toFixed(2) || "N/A"}
Middle: $${data.bollinger?.middle?.toFixed(2) || "N/A"}
Lower: $${data.bollinger?.lower?.toFixed(2) || "N/A"}
Position: ${data.bollinger?.position?.replace(/_/g, " ").toUpperCase() || "N/A"}

--- Volatility ---
Annualized: ${data.volatility?.annualized_percent?.toFixed(2) || "N/A"}%
Level: ${data.volatility?.level?.toUpperCase() || "N/A"}`
}

function getCorrelationExplanation(correlation: number | null): string {
  if (correlation === null) return ""

  if (correlation >= 0.7) {
    return "Strong positive correlation: These assets tend to move together. Not ideal for diversification but good for confirmation trades."
  } else if (correlation >= 0.4) {
    return "Moderate positive correlation: Some tendency to move together. Partial diversification benefit."
  } else if (correlation >= -0.4) {
    return "Weak or no correlation: Assets move independently. Good for portfolio diversification."
  } else if (correlation >= -0.7) {
    return "Moderate negative correlation: Tendency to move in opposite directions. Good for hedging."
  } else {
    return "Strong negative correlation: Assets tend to move in opposite directions. Excellent for hedging strategies."
  }
}
