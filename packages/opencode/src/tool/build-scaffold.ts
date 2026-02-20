import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const STRATEGY_DIR = "strategies"

const STRATEGY_TYPES = [
  "momentum",
  "mean-reversion",
  "breakout",
  "dca",
  "golden-cross",
  "scalping",
  "custom",
] as const

type StrategyType = (typeof STRATEGY_TYPES)[number]

const STRATEGY_TEMPLATES: Record<StrategyType, string> = {
  momentum: `"""
Momentum Strategy
-----------------
Buys when RSI indicates oversold conditions, sells when overbought.
Uses RSI (Relative Strength Index) to identify momentum shifts.

Parameters:
- rsi_period: Number of bars for RSI calculation (default: 14)
- rsi_oversold: RSI threshold to buy (default: 30)
- rsi_overbought: RSI threshold to sell (default: 70)
"""

from collections import deque


class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = deque(maxlen=50)

        # RSI Parameters
        self.rsi_period = 14
        self.rsi_oversold = 30
        self.rsi_overbought = 70

        # Track gains and losses for RSI
        self.gains = deque(maxlen=self.rsi_period)
        self.losses = deque(maxlen=self.rsi_period)
        self.last_price = None

    def calculate_rsi(self) -> float:
        """Calculate RSI from recent price changes."""
        if len(self.gains) < self.rsi_period:
            return 50.0  # Neutral when insufficient data

        avg_gain = sum(self.gains) / len(self.gains)
        avg_loss = sum(self.losses) / len(self.losses)

        if avg_loss == 0:
            return 100.0

        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]  # Use open price to avoid lookahead bias
        self.prices.append(price)

        # Update gains/losses for RSI
        if self.last_price is not None:
            change = price - self.last_price
            if change > 0:
                self.gains.append(change)
                self.losses.append(0)
            else:
                self.gains.append(0)
                self.losses.append(abs(change))
        self.last_price = price

        # Need enough data for RSI
        if len(self.prices) < self.rsi_period + 1:
            return "HOLD"

        rsi = self.calculate_rsi()

        # Buy Signal: RSI oversold
        if rsi < self.rsi_oversold and self.position == 0:
            self.position = 1
            return "BUY"

        # Sell Signal: RSI overbought
        if rsi > self.rsi_overbought and self.position == 1:
            self.position = 0
            return "SELL"

        return "HOLD"
`,

  "mean-reversion": `"""
Mean Reversion Strategy
-----------------------
Buys when price drops below the lower Bollinger Band (oversold).
Sells when price rises above the upper Bollinger Band (overbought).

Parameters:
- bb_period: Lookback period for moving average (default: 20)
- bb_std: Standard deviation multiplier (default: 2.0)
"""

from collections import deque
import statistics


class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = deque(maxlen=50)

        # Bollinger Band Parameters
        self.bb_period = 20
        self.bb_std = 2.0

    def calculate_bollinger_bands(self):
        """Calculate Bollinger Bands (upper, middle, lower)."""
        if len(self.prices) < self.bb_period:
            return None, None, None

        recent = list(self.prices)[-self.bb_period:]
        middle = statistics.mean(recent)
        std = statistics.stdev(recent) if len(recent) > 1 else 0

        upper = middle + (self.bb_std * std)
        lower = middle - (self.bb_std * std)

        return upper, middle, lower

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]  # Use open price to avoid lookahead bias
        self.prices.append(price)

        # Need enough data for Bollinger Bands
        if len(self.prices) < self.bb_period:
            return "HOLD"

        upper, middle, lower = self.calculate_bollinger_bands()
        if upper is None:
            return "HOLD"

        # Buy Signal: Price below lower band (oversold)
        if price < lower and self.position == 0:
            self.position = 1
            return "BUY"

        # Sell Signal: Price above upper band (overbought)
        if price > upper and self.position == 1:
            self.position = 0
            return "SELL"

        # Also sell at middle band for mean reversion
        if price >= middle and self.position == 1:
            self.position = 0
            return "SELL"

        return "HOLD"
`,

  breakout: `"""
Breakout Strategy
-----------------
Buys when price breaks above recent resistance (high of N bars).
Sells when price breaks below recent support (low of N bars).

Parameters:
- lookback: Number of bars for support/resistance (default: 20)
- breakout_pct: Percentage above/below to confirm breakout (default: 0.5%)
"""

from collections import deque


class Strategy:
    def __init__(self):
        self.position = 0
        self.highs = deque(maxlen=50)
        self.lows = deque(maxlen=50)
        self.prices = deque(maxlen=50)

        # Breakout Parameters
        self.lookback = 20
        self.breakout_pct = 0.005  # 0.5% breakout confirmation

        # Trade Management
        self.entry_price = 0.0
        self.stop_loss_pct = 0.03  # 3% stop loss

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.prices.append(price)
        self.highs.append(bar["high"])
        self.lows.append(bar["low"])

        # Need enough data
        if len(self.prices) < self.lookback:
            return "HOLD"

        # Calculate support and resistance
        recent_highs = list(self.highs)[-self.lookback:-1]  # Exclude current
        recent_lows = list(self.lows)[-self.lookback:-1]

        resistance = max(recent_highs)
        support = min(recent_lows)

        # Position management - stop loss
        if self.position == 1:
            if price < self.entry_price * (1 - self.stop_loss_pct):
                self.position = 0
                return "SELL"

        # Breakout Buy: Price breaks above resistance
        if price > resistance * (1 + self.breakout_pct) and self.position == 0:
            self.position = 1
            self.entry_price = price
            return "BUY"

        # Breakdown Sell: Price breaks below support
        if price < support * (1 - self.breakout_pct) and self.position == 1:
            self.position = 0
            return "SELL"

        return "HOLD"
`,

  dca: `"""
Dollar Cost Averaging (DCA) Strategy
------------------------------------
Systematically buys at regular intervals, accumulating a position over time.
Sells when significant profit target is reached.

Parameters:
- buy_interval: Number of bars between buys (default: 10)
- max_position: Maximum position size (default: 10)
- take_profit_pct: Profit target to sell all (default: 20%)
"""


class Strategy:
    def __init__(self):
        self.position = 0
        self.bar_count = 0
        self.average_cost = 0.0

        # DCA Parameters
        self.buy_interval = 10  # Buy every N bars
        self.max_position = 10  # Maximum units to accumulate
        self.take_profit_pct = 0.20  # 20% profit target

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.bar_count += 1

        # Take Profit: Sell all if we hit the target
        if self.position > 0:
            current_value = self.position * price
            cost_basis = self.position * self.average_cost
            profit_pct = (current_value - cost_basis) / cost_basis if cost_basis > 0 else 0

            if profit_pct >= self.take_profit_pct:
                self.position = 0
                self.average_cost = 0.0
                return "SELL"

        # DCA Buy: Buy at regular intervals if below max position
        if self.bar_count % self.buy_interval == 0 and self.position < self.max_position:
            # Update average cost
            total_cost = (self.average_cost * self.position) + price
            self.position += 1
            self.average_cost = total_cost / self.position
            return "BUY"

        return "HOLD"
`,

  "golden-cross": `"""
Golden Cross Strategy
---------------------
Classic moving average crossover strategy.
Buys when short MA crosses above long MA (golden cross).
Sells when short MA crosses below long MA (death cross).

Parameters:
- short_period: Short moving average period (default: 20)
- long_period: Long moving average period (default: 50)
"""

from collections import deque
import statistics


class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = deque(maxlen=100)

        # Moving Average Parameters
        self.short_period = 20
        self.long_period = 50

        # Track previous MA values for crossover detection
        self.prev_short_ma = None
        self.prev_long_ma = None

    def calculate_sma(self, period: int) -> float:
        """Calculate Simple Moving Average."""
        if len(self.prices) < period:
            return None

        return statistics.mean(list(self.prices)[-period:])

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.prices.append(price)

        # Need enough data for long MA
        if len(self.prices) < self.long_period:
            return "HOLD"

        short_ma = self.calculate_sma(self.short_period)
        long_ma = self.calculate_sma(self.long_period)

        if short_ma is None or long_ma is None:
            return "HOLD"

        # Check for crossover
        if self.prev_short_ma is not None and self.prev_long_ma is not None:
            # Golden Cross: Short MA crosses above Long MA
            if self.prev_short_ma <= self.prev_long_ma and short_ma > long_ma:
                if self.position == 0:
                    self.position = 1
                    self.prev_short_ma = short_ma
                    self.prev_long_ma = long_ma
                    return "BUY"

            # Death Cross: Short MA crosses below Long MA
            if self.prev_short_ma >= self.prev_long_ma and short_ma < long_ma:
                if self.position == 1:
                    self.position = 0
                    self.prev_short_ma = short_ma
                    self.prev_long_ma = long_ma
                    return "SELL"

        self.prev_short_ma = short_ma
        self.prev_long_ma = long_ma

        return "HOLD"
`,

  scalping: `"""
Scalping Strategy
-----------------
High-frequency strategy targeting small, quick profits.
Uses price momentum and volatility to find short-term opportunities.

Parameters:
- momentum_period: Bars for momentum calculation (default: 5)
- take_profit_pct: Quick profit target (default: 0.5%)
- stop_loss_pct: Tight stop loss (default: 0.3%)
"""

from collections import deque
import statistics


class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = deque(maxlen=20)

        # Scalping Parameters
        self.momentum_period = 5
        self.take_profit_pct = 0.005  # 0.5% profit target
        self.stop_loss_pct = 0.003    # 0.3% stop loss

        # Trade State
        self.entry_price = 0.0
        self.bars_in_trade = 0
        self.max_bars = 10  # Exit after N bars regardless

    def calculate_momentum(self) -> float:
        """Calculate price momentum (rate of change)."""
        if len(self.prices) < self.momentum_period:
            return 0.0

        recent = list(self.prices)[-self.momentum_period:]
        if recent[0] == 0:
            return 0.0

        return (recent[-1] - recent[0]) / recent[0]

    def calculate_volatility(self) -> float:
        """Calculate recent price volatility."""
        if len(self.prices) < self.momentum_period:
            return 0.0

        recent = list(self.prices)[-self.momentum_period:]
        if len(recent) < 2:
            return 0.0

        return statistics.stdev(recent) / statistics.mean(recent)

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.prices.append(price)

        # Need enough data
        if len(self.prices) < self.momentum_period:
            return "HOLD"

        # Position management
        if self.position == 1:
            self.bars_in_trade += 1
            pnl_pct = (price - self.entry_price) / self.entry_price

            # Take profit
            if pnl_pct >= self.take_profit_pct:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            # Stop loss
            if pnl_pct <= -self.stop_loss_pct:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            # Time-based exit
            if self.bars_in_trade >= self.max_bars:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            return "HOLD"

        # Entry logic: Look for positive momentum in low volatility
        momentum = self.calculate_momentum()
        volatility = self.calculate_volatility()

        # Buy when momentum is positive and volatility is reasonable
        if momentum > 0.002 and volatility < 0.02:  # 0.2% momentum, <2% volatility
            self.position = 1
            self.entry_price = price
            self.bars_in_trade = 0
            return "BUY"

        return "HOLD"
`,

  custom: `"""
Custom Strategy Template
------------------------
A blank template for implementing your own trading logic.
Customize the on_tick method with your strategy rules.

Guidelines:
- Use bar["open"] for entry decisions to avoid lookahead bias
- Return "BUY", "SELL", or "HOLD" from on_tick
- Use bounded data structures (deque with maxlen)
- Handle edge cases (insufficient data, division by zero)

Allowed imports:
- math, statistics, collections, dataclasses, typing
- decimal, random, itertools, functools
"""

from collections import deque


class Strategy:
    def __init__(self):
        # Position tracking (0 = flat, 1 = long)
        self.position = 0

        # Price history with bounded memory
        self.prices = deque(maxlen=100)

        # Add your custom state variables here
        # self.my_indicator = 0.0
        # self.entry_price = 0.0

    def on_tick(self, bar: dict) -> str:
        """
        Called on each new price bar.

        Args:
            bar: Dictionary with keys:
                - symbol: Trading symbol (e.g., "BTC")
                - open: Opening price (use this for decisions)
                - high: High price
                - low: Low price
                - close: Closing price
                - volume: Trading volume
                - timestamp: Unix timestamp

        Returns:
            "BUY" - Enter long position
            "SELL" - Exit position
            "HOLD" - Do nothing
        """
        price = bar["open"]  # Use open price for decisions
        self.prices.append(price)

        # Wait for enough data
        if len(self.prices) < 10:
            return "HOLD"

        # =====================
        # YOUR LOGIC GOES HERE
        # =====================

        # Example: Simple price comparison
        # if price < self.prices[-2] and self.position == 0:
        #     self.position = 1
        #     return "BUY"
        #
        # if price > self.prices[-2] * 1.01 and self.position == 1:
        #     self.position = 0
        #     return "SELL"

        return "HOLD"
`,
}

export const ScaffoldStrategyTool = Tool.define("scaffold_strategy", async () => {
  return {
    description:
      "Generate a new strategy file from a template. Creates a complete, working strategy with " +
      "comments and helper methods. Saves to the strategies/ folder, ready for customization and deployment.",
    parameters: z.object({
      name: z
        .string()
        .describe("Name for the strategy (will be used as filename, e.g., 'my_momentum' -> my_momentum.py)"),
      type: z
        .enum(STRATEGY_TYPES)
        .optional()
        .default("custom")
        .describe(
          "Strategy template type: momentum (RSI-based), mean-reversion (Bollinger Bands), " +
            "breakout (support/resistance), dca (dollar cost averaging), golden-cross (MA crossover), " +
            "scalping (high-frequency), custom (blank template)"
        ),
      symbol: z
        .string()
        .optional()
        .default("BTC")
        .describe("Primary trading symbol for comments (default: BTC)"),
    }),
    async execute(params, ctx): Promise<{title: string; output: string; metadata: Record<string, any>}> {
      try {
        // Sanitize name
        const sanitizedName = params.name
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/_+/g, "_")

        if (!sanitizedName) {
          return {
            title: "Scaffold Failed",
            output: "Invalid strategy name. Use alphanumeric characters and underscores.",
            metadata: { created: false, error: "invalid_name" },
          }
        }

        const filename = `${sanitizedName}.py`
        const strategiesDir = path.join(Instance.directory, STRATEGY_DIR)
        const filepath = path.join(strategiesDir, filename)

        // Check if file already exists
        const exists = await fs.promises
          .access(filepath)
          .then(() => true)
          .catch(() => false)

        if (exists) {
          return {
            title: "Scaffold Failed",
            output: `Strategy file "${filename}" already exists.

**Options:**
1. Choose a different name
2. Delete or rename the existing file
3. Use \`get_strategy_code\` to view the existing strategy

**Existing file:** ${filepath}`,
            metadata: { created: false, error: "file_exists", path: filepath },
          }
        }

        // Ensure strategies directory exists
        await fs.promises.mkdir(strategiesDir, { recursive: true })

        // Get template
        const template = STRATEGY_TEMPLATES[params.type || "custom"]

        // Customize template with metadata
        const header = `# Strategy: ${sanitizedName}
# Symbol: ${params.symbol?.toUpperCase() || "BTC"}
# Type: ${params.type || "custom"}
# Created: ${new Date().toISOString()}
#
# To deploy: finny deploy ${sanitizedName}
# To validate: finny validate ${sanitizedName}

`
        const code = header + template

        // Write file
        await fs.promises.writeFile(filepath, code, "utf-8")

        const relPath = path.relative(Instance.directory, filepath)
        const lines = code.split("\n").length

        return {
          title: `Strategy Created: ${sanitizedName}`,
          output: `Strategy "${sanitizedName}" created successfully!

**File:** \`${relPath}\`
**Type:** ${params.type || "custom"}
**Lines:** ${lines}

## Template Features

${getTemplateFeatures(params.type || "custom")}

## Next Steps

1. **Review the code:**
   \`\`\`
   get_strategy_code ${sanitizedName}
   \`\`\`

2. **Customize the parameters** in \`__init__\`

3. **Modify the trading logic** in \`on_tick\`

4. **Validate before deploying:**
   \`\`\`
   validate_strategy ${sanitizedName}
   \`\`\`

5. **Deploy to the arena:**
   \`\`\`
   deploy_strategy ${sanitizedName}
   \`\`\`

Happy trading! 🚀`,
          metadata: {
            created: true,
            name: sanitizedName,
            path: relPath,
            type: params.type || "custom",
            lines,
          },
        }
      } catch (error: any) {
        return {
          title: "Scaffold Error",
          output: `Failed to create strategy: ${error.message}`,
          metadata: { created: false, error: error.message },
        }
      }
    },
  }
})

function getTemplateFeatures(type: StrategyType): string {
  const features: Record<StrategyType, string> = {
    momentum: `- **RSI indicator** for momentum detection
- Configurable overbought/oversold thresholds
- Proper gain/loss tracking for accurate RSI`,
    "mean-reversion": `- **Bollinger Bands** for mean reversion signals
- Configurable period and standard deviation
- Sells at middle band for quick mean reversion`,
    breakout: `- **Support/Resistance breakout** detection
- Configurable lookback period
- Built-in stop loss protection`,
    dca: `- **Dollar Cost Averaging** accumulation
- Configurable buy interval and max position
- Take profit target for selling`,
    "golden-cross": `- **Moving Average Crossover** (Golden/Death Cross)
- Configurable short and long MA periods
- Proper crossover detection logic`,
    scalping: `- **High-frequency scalping** approach
- Momentum and volatility filters
- Tight profit targets and stop losses
- Time-based exit for stale trades`,
    custom: `- Blank template for custom logic
- Properly structured Strategy class
- Comments explaining the interface
- Example code snippets included`,
  }
  return features[type]
}
