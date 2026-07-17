import { TextAttributes } from "@opentui/core"
import { onMount } from "solid-js"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"

export interface DialogBacktestRunningProps {
  algorithmName: string
}

export function DialogBacktestRunning(props: DialogBacktestRunningProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("medium")
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Backtest — {props.algorithmName}
        </text>
      </box>
      <box paddingBottom={1} gap={1}>
        <Spinner color={theme.primary}>Running backtest...</Spinner>
        <text fg={theme.textMuted}>Downloading market data and executing strategy</text>
      </box>
    </box>
  )
}

DialogBacktestRunning.show = (dialog: DialogContext, algorithmName: string) => {
  dialog.replace(() => <DialogBacktestRunning algorithmName={algorithmName} />)
}
