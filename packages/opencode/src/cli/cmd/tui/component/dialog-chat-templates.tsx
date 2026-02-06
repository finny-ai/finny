import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, For } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { usePromptRef } from "@tui/context/prompt"

interface ChatTemplate {
  id: string
  name: string
  description: string
  prompt: string
}

const CHAT_TEMPLATES: ChatTemplate[] = [
  {
    id: "portfolio-analysis",
    name: "Portfolio Analysis",
    description: "Review your portfolio performance and allocation",
    prompt: `Please give me a comprehensive analysis of my trading portfolio.

**I'd like to understand:**
- Overall portfolio performance (equity, P&L, ROI)
- Performance breakdown by symbol/strategy
- Current positions and exposure
- Trade statistics and win rate
- Any concerning patterns or risks

**Please include:**
- Recommendations for rebalancing if needed
- Comparison to market benchmarks
- Suggestions for improvement

Use the portfolio summary tool to get the latest data.`,
  },
  {
    id: "market-conditions",
    name: "Market Conditions",
    description: "Get a comprehensive market overview",
    prompt: `Please give me a comprehensive overview of current market conditions.

**I'd like to know:**
- Current prices for major assets (crypto and stocks)
- 24-hour price changes and trends
- Overall market sentiment
- Top gainers and losers
- Any notable patterns or correlations

**Also help me understand:**
- What's driving today's market moves
- Key support/resistance levels to watch
- Potential trading opportunities

Use the market overview tool to get the latest data, and search for relevant news if helpful.`,
  },
  {
    id: "strategy-ideation",
    name: "Strategy Ideation",
    description: "Brainstorm new trading strategy ideas",
    prompt: `Help me brainstorm new trading strategy ideas.

**My interests:**
- Asset class: [crypto / stocks / both]
- Trading style: [day trading / swing trading / position trading]
- Risk tolerance: [conservative / moderate / aggressive]

**Please suggest:**
- 2-3 strategy concepts that match my profile
- The core logic and indicators for each
- Entry and exit conditions
- Risk management approach
- Expected trade frequency

**Consider:**
- Current market conditions
- Correlation with my existing strategies
- Complexity vs. potential returns

Let me know which approach you'd recommend and why.`,
  },
  {
    id: "strategy-review",
    name: "Strategy Review",
    description: "Analyze your deployed strategy performance",
    prompt: `Please review the performance of my deployed strategies.

**For each strategy, analyze:**
- Current P&L and ROI
- Win rate and average trade
- Maximum drawdown
- Sharpe ratio (if available)
- Recent trade history

**Help me understand:**
- Which strategies are performing well and why
- Which strategies need adjustment
- Whether any strategies should be stopped
- Optimization opportunities

**Compare:**
- Strategy performance vs. buy-and-hold
- Risk-adjusted returns
- Consistency of returns over time

Use the portfolio tool to get current data.`,
  },
  {
    id: "trading-news",
    name: "Trading News",
    description: "Discuss recent market news and implications",
    prompt: `Help me catch up on the latest trading news and its implications.

**I'm interested in:**
- Major market-moving events today/this week
- News affecting [BTC / ETH / tech stocks / all]
- Earnings reports and their impact
- Regulatory developments

**Please:**
- Summarize the key news items
- Explain how they might affect prices
- Identify potential trading opportunities
- Flag any risks I should be aware of

Use web search to find the latest news and help me interpret it.`,
  },
  {
    id: "risk-assessment",
    name: "Risk Assessment",
    description: "Evaluate portfolio and strategy risks",
    prompt: `Please help me assess the risks in my trading setup.

**Evaluate:**
- Portfolio concentration risk
- Correlation between strategies/positions
- Maximum potential drawdown
- Exposure to different market scenarios

**Analyze scenarios:**
- What happens if the market drops 20%?
- What's my risk if a single position goes to zero?
- How correlated are my strategies?

**Recommend:**
- Risk mitigation strategies
- Position sizing adjustments
- Hedging opportunities
- Stop-loss improvements

Use the portfolio tool to analyze my current positions.`,
  },
]

export function DialogChatTemplates() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const promptRef = usePromptRef()

  const [selected, setSelected] = createSignal(0)

  function selectTemplate() {
    const template = CHAT_TEMPLATES[selected()]
    if (template && promptRef.current) {
      // Set the prompt text and close dialog
      promptRef.current.setInput(template.prompt)
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

    if (evt.name === "up" || evt.key === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down" || evt.key === "j") {
      setSelected((s) => Math.min(CHAT_TEMPLATES.length - 1, s + 1))
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Chat Templates
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <text fg={theme.textMuted}>Select a template to start your conversation</text>

      <box marginTop={1}>
        <For each={CHAT_TEMPLATES}>
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
export const ChatTemplates = {
  portfolioAnalysis: CHAT_TEMPLATES.find((t) => t.id === "portfolio-analysis")!,
  marketConditions: CHAT_TEMPLATES.find((t) => t.id === "market-conditions")!,
  strategyIdeation: CHAT_TEMPLATES.find((t) => t.id === "strategy-ideation")!,
  strategyReview: CHAT_TEMPLATES.find((t) => t.id === "strategy-review")!,
  tradingNews: CHAT_TEMPLATES.find((t) => t.id === "trading-news")!,
  riskAssessment: CHAT_TEMPLATES.find((t) => t.id === "risk-assessment")!,
}
