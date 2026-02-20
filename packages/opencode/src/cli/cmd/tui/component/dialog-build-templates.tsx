import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, For } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { usePromptRef } from "@tui/context/prompt"

interface BuildTemplate {
  id: string
  name: string
  description: string
  type: "momentum" | "mean-reversion" | "breakout" | "dca" | "golden-cross" | "scalping" | "custom"
  prompt: string
}

const BUILD_TEMPLATES: BuildTemplate[] = [
  {
    id: "momentum",
    name: "Momentum Strategy",
    description: "RSI-based trend following with overbought/oversold signals",
    type: "momentum",
    prompt: `Create a momentum trading strategy with the following specifications:

**Strategy Type:** Momentum (RSI-based)
**Symbol:** BTC

**Requirements:**
- Use RSI indicator to identify entry/exit points
- Buy when RSI drops below 30 (oversold)
- Sell when RSI rises above 70 (overbought)
- Configurable RSI period (default: 14)

**Risk Management:**
- Position sizing: 1 unit per trade
- No leverage

Please use the scaffold_strategy tool to generate the template, then customize the parameters. After writing the code, validate it with validate_strategy and deploy with deploy_strategy.`,
  },
  {
    id: "mean-reversion",
    name: "Mean Reversion Strategy",
    description: "Bollinger Bands strategy that buys dips and sells rallies",
    type: "mean-reversion",
    prompt: `Create a mean reversion trading strategy with the following specifications:

**Strategy Type:** Mean Reversion (Bollinger Bands)
**Symbol:** BTC

**Requirements:**
- Use Bollinger Bands to identify extreme price levels
- Buy when price drops below the lower band (oversold)
- Sell when price returns to the middle band or exceeds upper band
- Configurable period (default: 20) and standard deviation (default: 2)

**Risk Management:**
- Position sizing: 1 unit per trade
- Exit at middle band for quick mean reversion

Please use the scaffold_strategy tool with type "mean-reversion" to generate the template, then customize the parameters. Validate and deploy when ready.`,
  },
  {
    id: "breakout",
    name: "Breakout Strategy",
    description: "Support/resistance breakout with confirmation",
    type: "breakout",
    prompt: `Create a breakout trading strategy with the following specifications:

**Strategy Type:** Breakout (Support/Resistance)
**Symbol:** BTC

**Requirements:**
- Identify support and resistance from recent highs/lows
- Buy when price breaks above resistance with confirmation
- Sell when price breaks below support or hits stop loss
- Configurable lookback period (default: 20 bars)

**Risk Management:**
- Stop loss at 3% below entry
- Breakout confirmation: 0.5% above resistance

Please use the scaffold_strategy tool with type "breakout" to generate the template, then customize. Validate and deploy when ready.`,
  },
  {
    id: "dca",
    name: "DCA Strategy",
    description: "Dollar cost averaging with profit target",
    type: "dca",
    prompt: `Create a Dollar Cost Averaging (DCA) strategy with the following specifications:

**Strategy Type:** DCA (Accumulation)
**Symbol:** BTC

**Requirements:**
- Buy a fixed amount at regular intervals
- Accumulate position over time (max 10 units)
- Sell all when profit target reached (20%)
- Track average cost basis

**Risk Management:**
- Systematic buying reduces timing risk
- Position limit prevents over-concentration

Please use the scaffold_strategy tool with type "dca" to generate the template, then customize the buy interval and profit target. Validate and deploy when ready.`,
  },
  {
    id: "golden-cross",
    name: "Golden Cross Strategy",
    description: "Classic moving average crossover system",
    type: "golden-cross",
    prompt: `Create a Golden Cross trading strategy with the following specifications:

**Strategy Type:** Moving Average Crossover
**Symbol:** BTC

**Requirements:**
- Track short-term (20) and long-term (50) moving averages
- Buy on Golden Cross (short MA crosses above long MA)
- Sell on Death Cross (short MA crosses below long MA)
- Proper crossover detection (compare previous and current values)

**Risk Management:**
- Trend-following approach reduces whipsaws
- Clear entry/exit signals

Please use the scaffold_strategy tool with type "golden-cross" to generate the template, then customize the MA periods. Validate and deploy when ready.`,
  },
  {
    id: "scalping",
    name: "Scalping Strategy",
    description: "High-frequency small gains with tight stops",
    type: "scalping",
    prompt: `Create a scalping trading strategy with the following specifications:

**Strategy Type:** Scalping (High-Frequency)
**Symbol:** BTC

**Requirements:**
- Target small, quick profits (0.5% target)
- Use momentum and volatility filters for entry
- Tight stop loss (0.3%)
- Time-based exit (max 10 bars in trade)

**Risk Management:**
- Quick profit taking
- Strict stop losses
- Volatility filter to avoid choppy markets

Please use the scaffold_strategy tool with type "scalping" to generate the template, then customize the profit/loss targets. Validate and deploy when ready.`,
  },
  {
    id: "custom",
    name: "Custom Strategy",
    description: "Blank template for your own logic",
    type: "custom",
    prompt: `I want to create a custom trading strategy from scratch.

**Symbol:** BTC (or specify your preferred symbol)

Please use the scaffold_strategy tool with type "custom" to generate a blank template. The template will include:
- Properly structured Strategy class
- on_tick method signature
- Example code snippets (commented out)
- Guidelines for allowed imports

After generating the scaffold, I'll describe my strategy logic and you can help me implement it. Once coded, validate with validate_strategy and deploy with deploy_strategy.

What's your strategy idea?`,
  },
]

export function DialogBuildTemplates() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const promptRef = usePromptRef()

  const [selected, setSelected] = createSignal(0)

  function selectTemplate() {
    const template = BUILD_TEMPLATES[selected()]
    if (template && promptRef.current) {
      // Set the prompt text and close dialog
      promptRef.current.set({ input: template.prompt, parts: [] })
      dialog.clear()
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      dialog.clear()
      return
    }

    if (evt.name === "return" || evt.name === "enter") {
      selectTemplate()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down" || evt.name === "j") {
      setSelected((s) => Math.min(BUILD_TEMPLATES.length - 1, s + 1))
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Build Templates
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <text fg={theme.textMuted}>Select a strategy template to scaffold</text>

      <box marginTop={1}>
        <For each={BUILD_TEMPLATES}>
          {(template, i) => (
            <box
              flexDirection="column"
              backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={selected() === i() ? 1 : 0}
              paddingBottom={selected() === i() ? 1 : 0}
            >
              <box flexDirection="row" gap={1}>
                <text fg={selected() === i() ? theme.accent : theme.textMuted}>
                  {selected() === i() ? "\u25b6" : " "}
                </text>
                <text fg={theme.text} attributes={selected() === i() ? TextAttributes.BOLD : undefined}>
                  {template.name}
                </text>
                <text fg={theme.textMuted}>
                  ({template.type})
                </text>
              </box>
              {selected() === i() && (
                <text fg={theme.textMuted} marginLeft={2}>
                  {template.description}
                </text>
              )}
            </box>
          )}
        </For>
      </box>

      <text fg={theme.textMuted} marginTop={1}>
        <b>enter</b> select <b>j/k</b> navigate
      </text>
    </box>
  )
}

// Export individual template prompts for direct use
export const BuildTemplates = {
  momentum: BUILD_TEMPLATES.find((t) => t.id === "momentum")!,
  meanReversion: BUILD_TEMPLATES.find((t) => t.id === "mean-reversion")!,
  breakout: BUILD_TEMPLATES.find((t) => t.id === "breakout")!,
  dca: BUILD_TEMPLATES.find((t) => t.id === "dca")!,
  goldenCross: BUILD_TEMPLATES.find((t) => t.id === "golden-cross")!,
  scalping: BUILD_TEMPLATES.find((t) => t.id === "scalping")!,
  custom: BUILD_TEMPLATES.find((t) => t.id === "custom")!,
}
