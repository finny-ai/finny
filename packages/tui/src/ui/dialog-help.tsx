import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"

const CAN = [
  "Generate Python trading strategies from a description",
  "Backtest them on historical data",
  "Run walk-forward checks and parameter sweeps",
  "Save versions, compare, and export strategy files",
]

const CANT = ["Predict future prices", "Place live trades without explicit confirmation", "Do tax math"]

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Welcome to Finny
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>

      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Finny is an AI assistant for designing and backtesting algorithmic trading strategies in plain English.
        </text>
      </box>

      <box>
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

      <box paddingTop={1}>
        <text fg={theme.textMuted}>
          Press {commandShortcut()} to see all available actions and commands in any context.
        </text>
      </box>

      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} paddingTop={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
