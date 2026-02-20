import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, For } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { usePromptRef } from "@tui/context/prompt"

interface ResearchTemplate {
  id: string
  name: string
  description: string
  prompt: string
}

const RESEARCH_TEMPLATES: ResearchTemplate[] = [
  {
    id: "momentum",
    name: "Momentum Strategy Research",
    description: "Analyze trend-following opportunities using momentum indicators",
    prompt: `I want to research a momentum-based trading strategy. Please analyze:

**Asset Selection:**
- [Specify asset: BTC, ETH, AAPL, etc.]

**Analysis Focus:**
- Trend strength using ADX or similar
- RSI for overbought/oversold confirmation
- MACD for momentum direction
- Volume analysis for trend confirmation

**Strategy Parameters:**
- Entry conditions when momentum is strong
- Exit conditions for taking profits
- Stop-loss placement based on volatility

**Risk Considerations:**
- Maximum drawdown tolerance
- Position sizing approach
- Correlation with market`,
  },
  {
    id: "mean-reversion",
    name: "Mean Reversion Strategy Research",
    description: "Find opportunities when prices deviate from their average",
    prompt: `I want to research a mean reversion trading strategy. Please analyze:

**Asset Selection:**
- [Specify asset: BTC, ETH, AAPL, etc.]

**Analysis Focus:**
- Bollinger Bands for price deviations
- RSI for extreme readings (below 30 or above 70)
- Standard deviation and volatility levels
- Historical mean-reversion patterns

**Strategy Parameters:**
- Entry when price reaches lower/upper bands
- Exit at middle band or opposite band
- Stop-loss beyond recent extremes

**Risk Considerations:**
- False breakout protection
- Maximum holding period
- Position sizing for volatile conditions`,
  },
  {
    id: "earnings",
    name: "Earnings-Based Strategy Research",
    description: "Research strategies around company earnings events",
    prompt: `I want to research an earnings-based trading strategy. Please analyze:

**Stock Selection:**
- [Specify stock: AAPL, NVDA, PLTR, etc.]

**Pre-Earnings Analysis:**
- Historical price behavior before earnings
- Implied volatility patterns
- Analyst expectations vs. historical beats/misses

**Strategy Parameters:**
- Entry timing (days before earnings)
- Position sizing for elevated volatility
- Exit timing (post-earnings fade or continuation)

**Risk Considerations:**
- Gap risk and overnight exposure
- IV crush effects if using options
- Correlation with market sentiment`,
  },
  {
    id: "breakout",
    name: "Breakout Strategy Research",
    description: "Identify consolidation patterns and breakout opportunities",
    prompt: `I want to research a breakout trading strategy. Please analyze:

**Asset Selection:**
- [Specify asset: BTC, ETH, AAPL, etc.]

**Analysis Focus:**
- Support and resistance levels
- Bollinger Band squeeze (low bandwidth)
- Volume patterns during consolidation
- Historical breakout success rates

**Strategy Parameters:**
- Entry on confirmed breakout with volume
- Stop-loss placement (below breakout level)
- Profit targets based on range projection

**Risk Considerations:**
- False breakout protection
- Retest entry opportunities
- Position sizing based on stop distance`,
  },
  {
    id: "pairs",
    name: "Pairs Trading Research",
    description: "Find correlated assets for market-neutral strategies",
    prompt: `I want to research a pairs trading strategy. Please analyze:

**Asset Pairs:**
- [Specify pairs: BTC/ETH, AAPL/MSFT, etc.]

**Analysis Focus:**
- Historical correlation coefficient
- Spread behavior and mean reversion
- Volatility of the spread
- Cointegration analysis

**Strategy Parameters:**
- Entry when spread deviates N standard deviations
- Exit when spread returns to mean
- Hedging ratios based on beta

**Risk Considerations:**
- Correlation breakdown scenarios
- Divergence risk management
- Capital allocation between legs`,
  },
]

export function DialogResearchTemplates() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const promptRef = usePromptRef()

  const [selected, setSelected] = createSignal(0)

  function selectTemplate() {
    const template = RESEARCH_TEMPLATES[selected()]
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
      setSelected((s) => Math.min(RESEARCH_TEMPLATES.length - 1, s + 1))
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Research Templates
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <text fg={theme.textMuted}>Select a template to start your research</text>

      <box marginTop={1}>
        <For each={RESEARCH_TEMPLATES}>
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
export const ResearchTemplates = {
  momentum: RESEARCH_TEMPLATES.find((t) => t.id === "momentum")!,
  meanReversion: RESEARCH_TEMPLATES.find((t) => t.id === "mean-reversion")!,
  earnings: RESEARCH_TEMPLATES.find((t) => t.id === "earnings")!,
  breakout: RESEARCH_TEMPLATES.find((t) => t.id === "breakout")!,
  pairs: RESEARCH_TEMPLATES.find((t) => t.id === "pairs")!,
}
