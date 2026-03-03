import { createMemo, createSignal, For } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "@tui/context/theme"

const themeCount = Object.keys(DEFAULT_THEMES).length
const themeTip = `Use {highlight}/themes{/highlight} or {highlight}Ctrl+X T{/highlight} to switch between ${themeCount} built-in themes`

type TipPart = { text: string; highlight: boolean }

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

export function Tips() {
  const theme = useTheme().theme
  const parts = parse(TIPS[Math.floor(Math.random() * TIPS.length)])

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: theme.info }}>
        ● Tip{" "}
      </text>
      <text flexShrink={1}>
        <For each={parts}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS = [
  "Press {highlight}Tab{/highlight} to cycle between Build, Research, and Chat agents",
  "Use {highlight}Build{/highlight} mode to generate trading algorithms immediately from your specifications",
  "Use {highlight}Research{/highlight} mode to analyze a strategy idea before building it",
  "Use {highlight}Chat{/highlight} mode for market discussions and strategy Q&A without code changes",
  "Type {highlight}@{/highlight} followed by a filename to attach strategy files, data, or configs",
  "Start a message with {highlight}!{/highlight} to run shell commands directly (e.g., {highlight}!python backtest.py{/highlight})",
  "Use {highlight}/undo{/highlight} to revert the last message and file changes",
  "Use {highlight}/redo{/highlight} to restore previously undone messages and file changes",
  "Drag and drop CSV data files or chart images into the terminal as context",
  "Press {highlight}Ctrl+V{/highlight} to paste chart screenshots for visual strategy analysis",
  "Press {highlight}Ctrl+X E{/highlight} or {highlight}/editor{/highlight} to compose complex strategy prompts in your editor",
  "Run {highlight}/models{/highlight} or {highlight}Ctrl+X M{/highlight} to see and switch between available AI models",
  themeTip,
  "Press {highlight}Ctrl+X N{/highlight} or {highlight}/new{/highlight} to start a fresh strategy session",
  "Use {highlight}/sessions{/highlight} or {highlight}Ctrl+X L{/highlight} to revisit previous strategy conversations",
  "Run {highlight}/compact{/highlight} to summarize long sessions near context limits",
  "Press {highlight}Ctrl+X X{/highlight} or {highlight}/export{/highlight} to save strategy notes as Markdown",
  "Press {highlight}Ctrl+X Y{/highlight} to copy the assistant's last response to clipboard",
  "Press {highlight}Ctrl+P{/highlight} to see all available actions and commands",
  "Run {highlight}/connect{/highlight} to add API keys for LLM providers",
  "The leader key is {highlight}Ctrl+X{/highlight}; combine with other keys for quick actions",
  "Press {highlight}F2{/highlight} to quickly switch between recently used models",
  "Press {highlight}Ctrl+X B{/highlight} to show/hide the sidebar panel",
  "Use {highlight}PageUp{/highlight}/{highlight}PageDown{/highlight} to navigate through conversation history",
  "Press {highlight}Shift+Enter{/highlight} or {highlight}Ctrl+J{/highlight} to add newlines in your prompt",
  "Press {highlight}Escape{/highlight} to stop the AI mid-response",
  "Use {highlight}@agent-name{/highlight} in prompts to invoke specialized subagents",
  "Try describing strategies like: {highlight}pairs trading{/highlight}, {highlight}momentum{/highlight}, {highlight}mean reversion{/highlight}, or {highlight}volatility breakout{/highlight}",
  "Specify your preferred language: {highlight}Python{/highlight}, {highlight}Pine Script{/highlight}, or {highlight}MQL5{/highlight}",
  "Include risk parameters like {highlight}max drawdown{/highlight}, {highlight}position sizing{/highlight}, and {highlight}stop-loss{/highlight} in your prompts",
  "Ask Finny to add {highlight}backtesting logic{/highlight} to validate your strategy on historical data",
  "Request {highlight}portfolio optimization{/highlight} using Sharpe ratio, sortino ratio, or custom objectives",
  "Describe market conditions for your strategy: {highlight}trending{/highlight}, {highlight}range-bound{/highlight}, or {highlight}high-volatility{/highlight}",
  "Ask for {highlight}risk management{/highlight} features like trailing stops, Kelly criterion, or VaR calculations",
  "Run {highlight}/help{/highlight} to show the help dialog",
  "Use {highlight}/rename{/highlight} to rename the current session",
  "Press {highlight}Ctrl+Z{/highlight} to suspend the terminal and return to your shell",
]
