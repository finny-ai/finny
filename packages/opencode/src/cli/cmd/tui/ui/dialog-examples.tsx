import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useRoute } from "@tui/context/route"

// 7 built-in templates that map 1:1 to finny_algorithm_scaffold types
// (momentum / mean-reversion / breakout / dca / golden-cross / scalping /
// custom — see packages/opencode/src/algorithm/scaffold.* and the build
// prompt). Clicking a template fills the home prompt with a concrete build
// instruction so a non-technical user (Dodge-style) gets a working
// jumping-off point instead of a blinking cursor.
interface Template {
  name: string
  tagline: string
  prompt: string
}

const TEMPLATES: Template[] = [
  {
    name: "Momentum",
    tagline: "RSI momentum — buys oversold, sells overbought",
    prompt:
      "Build an RSI momentum strategy on BTC, 1h bars. Buy when RSI(14) crosses below 30 (oversold), sell when it crosses above 70 (overbought). Add a 3% stop loss.",
  },
  {
    name: "Mean Reversion",
    tagline: "Bollinger Bands — buys lower band, sells upper",
    prompt:
      "Build a Bollinger Bands mean-reversion strategy on BTC, 1h bars. Buy when price touches the lower band (20-period SMA, 2 std), sell when it touches the upper band. Add a 4% stop loss.",
  },
  {
    name: "Breakout",
    tagline: "Donchian channel — buys new highs, sells new lows",
    prompt:
      "Build a Donchian channel breakout strategy on BTC, 1h bars. Buy when price makes a new 20-period high, exit on a new 10-period low. Add a 5% stop loss.",
  },
  {
    name: "DCA",
    tagline: "Dollar-cost averaging with profit-target exit",
    prompt:
      "Build a dollar-cost averaging strategy on BTC, 1h bars. Buy a fixed dollar amount every 6 hours, sell each lot independently when it hits +10% profit target.",
  },
  {
    name: "Golden Cross",
    tagline: "SMA 50/200 crossover signals",
    prompt:
      "Build a golden-cross strategy on SPY, daily bars. Buy when the 50-day SMA crosses above the 200-day SMA, sell when it crosses back below.",
  },
  {
    name: "Scalping",
    tagline: "EMA scalping with tight stops",
    prompt:
      "Build an EMA scalping strategy on BTC, 5min bars. Use EMA 9/21 crossover with a tight 1% stop loss and 2% take profit. Skip trades during the first 5 minutes after each hour.",
  },
  {
    name: "Custom",
    tagline: "Minimal skeleton — implement your own logic",
    prompt: "Help me design a custom trading strategy. Ask me what signals, exits, and risk rules I want before writing any code.",
  },
]

export function DialogExamples() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const route = useRoute()
  const dimensions = useTerminalDimensions()

  const maxHeight = () => Math.floor(dimensions().height * 0.6)

  let scrollRef: any

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      dialog.clear()
      evt.preventDefault()
      return
    }
    if (!scrollRef) return
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      scrollRef.scrollBy(-1)
      evt.preventDefault()
    } else if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      scrollRef.scrollBy(1)
      evt.preventDefault()
    } else if (evt.name === "pageup") {
      scrollRef.scrollBy(-10)
      evt.preventDefault()
    } else if (evt.name === "pagedown") {
      scrollRef.scrollBy(10)
      evt.preventDefault()
    }
  })

  const pick = (template: Template) => {
    // Dialogs render OUTSIDE the route's context tree, so we can't grab
    // PromptRef directly here. Route-based navigation with `initialPrompt`
    // is the right channel — `routes/home.tsx` watches for changes and
    // applies it whenever the prompt mounts (or re-applies on a fresh
    // navigation).
    route.navigate({
      type: "home",
      initialPrompt: { input: template.prompt, parts: [] },
    })
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Strategy Templates
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>
        7 built-in templates to jumpstart your algorithm. Click one to fill the prompt, or press esc to go fully custom.
      </text>

      <scrollbox ref={(r: any) => (scrollRef = r)} maxHeight={maxHeight()} scrollbarOptions={{ visible: true }}>
        <box flexDirection="column" gap={1}>
          <For each={TEMPLATES}>
            {(t) => (
              <box
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.backgroundElement}
                onMouseUp={() => pick(t)}
              >
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  ▸ {t.name}
                </text>
                <text fg={theme.textMuted}>{t.tagline}</text>
              </box>
            )}
          </For>
        </box>
      </scrollbox>

      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>↑/↓</span> scroll · <span style={{ fg: theme.text }}>click</span> a template ·{" "}
        <span style={{ fg: theme.text }}>esc</span> close
      </text>
    </box>
  )
}
