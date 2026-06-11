import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { Plan } from "@/plan"

const CAN = [
  "Generate Python trading strategies from a description",
  "Backtest them on historical data (returns, Sharpe, drawdown, win rate)",
  "Walk-forward and parameter sweeps to detect overfit",
  "Save versions, compare, export to a file",
]

const CANT = [
  "Predict future prices",
  "Place live trades automatically (live runs are explicit and gated)",
  "Do tax math",
]

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()

  // Match the DialogAlgorithmCode ratio (0.6). Larger ratios overflowed on
  // smaller terminals because the dialog frame itself is sized by setSize.
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

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Welcome to Finny
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <scrollbox ref={(r: any) => (scrollRef = r)} maxHeight={maxHeight()} scrollbarOptions={{ visible: true }}>
        <box flexDirection="column" gap={1}>
          {/* Intro lives inside the scrollbox so the dialog frame stays compact
              regardless of terminal height. Header + scrollbox + footer is all
              the fixed chrome. */}
          <text fg={theme.textMuted}>
            Finny is an AI assistant for designing and backtesting algorithmic trading strategies in plain English.
          </text>
          <text fg={theme.textMuted}>
            New here? Run <span style={{ fg: theme.text }}>/examples</span> to pick from 7 built-in strategy templates.
          </text>

          {/* Capabilities */}
          <box paddingTop={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              What I do
            </text>
          </box>
          <For each={CAN}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.primary}>✓</text>
                <text fg={theme.text}>{item}</text>
              </box>
            )}
          </For>

          {/* Limits — set expectations explicitly so users don't ask Finny to predict prices */}
          <box paddingTop={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              What I can't do
            </text>
          </box>
          <For each={CANT}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.error}>✗</text>
                <text fg={theme.textMuted}>{item}</text>
              </box>
            )}
          </For>

          {/* Plan options */}
          <box paddingTop={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              Pick a plan
            </text>
          </box>
          <box flexDirection="column" gap={1}>
            <box flexDirection="column">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Free
              </text>
              <text fg={theme.textMuted}>
                Bring your own API key. Unlimited local algorithms and backtests.
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Lite
              </text>
              <text fg={theme.textMuted}>
                Finny-managed rate-limited models with unlimited local algorithms and backtests.
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Pro
              </text>
              <text fg={theme.textMuted}>
                Full-access models with unlimited local algorithms and backtests.
              </text>
            </box>
            <text fg={theme.primary}>Upgrade: {Plan.UPGRADE_URL}</text>
          </box>

          <box paddingTop={1}>
            <text fg={theme.textMuted}>
              Press {keybind.print("command_list")} to see every available command.
            </text>
          </box>
        </box>
      </scrollbox>

      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>↑/↓</span> scroll · <span style={{ fg: theme.text }}>esc</span> close
      </text>
    </box>
  )
}
