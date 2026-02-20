import { createMemo, createSignal, For } from "solid-js"
import { useTheme } from "@tui/context/theme"

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
      <text flexShrink={0} style={{ fg: theme.warning }}>
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
  "Use {highlight}/deploy{/highlight} to send your strategy to the simulator",
  "Use {highlight}/backtest{/highlight} to test a strategy against historical data",
  "Use {highlight}/price{/highlight} to see live market prices",
  "Use {highlight}/validate{/highlight} to check your strategy for errors",
  "Use {highlight}/code{/highlight} to view a deployed strategy's source code",
  "Use {highlight}/strategy-status{/highlight} to check your strategy's P&L",
  "Press {highlight}Tab{/highlight} to cycle between Build, Research, and Chat agents",
  "Press {highlight}Ctrl+P{/highlight} to see all available commands",
  "Press {highlight}Escape{/highlight} to stop the AI mid-response",
  "Press {highlight}Ctrl+X N{/highlight} or {highlight}/new{/highlight} to start a fresh session",
  "Use {highlight}/sessions{/highlight} to list and continue previous conversations",
  "Use {highlight}/compact{/highlight} to summarize long sessions near context limits",
  "Press {highlight}Shift+Enter{/highlight} to add newlines in your prompt",
  "Type {highlight}@{/highlight} followed by a filename to attach files as context",
  "Run {highlight}/connect{/highlight} to add API keys for LLM providers",
  "Run {highlight}/models{/highlight} to see and switch between available AI models",
]
