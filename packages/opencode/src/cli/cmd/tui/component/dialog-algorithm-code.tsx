import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { Algorithm } from "@/algorithm"

export interface DialogAlgorithmCodeProps {
  algorithm: Algorithm.Info
}

export function DialogAlgorithmCode(props: DialogAlgorithmCodeProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const maxHeight = () => Math.floor(dimensions().height * 0.6)

  let scrollRef: any

  useKeyboard((evt) => {
    if (!scrollRef) return
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      scrollRef.scrollBy(-1)
      evt.preventDefault()
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      scrollRef.scrollBy(1)
      evt.preventDefault()
    }
    if (evt.name === "pageup") {
      scrollRef.scrollBy(-10)
      evt.preventDefault()
    }
    if (evt.name === "pagedown") {
      scrollRef.scrollBy(10)
      evt.preventDefault()
    }
  })

  const updatedAt = () => {
    const d = new Date(props.algorithm.time_updated)
    return d.toLocaleDateString()
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.algorithm.name}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>
          v{props.algorithm.version} · {props.algorithm.status} · {props.algorithm.language} · {updatedAt()}
        </text>
      </box>

      <Show when={props.algorithm.description}>
        <text fg={theme.textMuted}>{props.algorithm.description}</text>
      </Show>

      <scrollbox
        ref={(r: any) => (scrollRef = r)}
        maxHeight={maxHeight()}
        scrollbarOptions={{ visible: true }}
      >
        <box gap={1}>
          <box>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              strategy.py
            </text>
          </box>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>{props.algorithm.code}</text>
          </box>

          <Show when={props.algorithm.config}>
            <box paddingTop={1}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                config.json
              </text>
            </box>
            <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{props.algorithm.config}</text>
            </box>
          </Show>

          <Show when={props.algorithm.backtestCode}>
            <box paddingTop={1}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                backtest.py
              </text>
            </box>
            <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{props.algorithm.backtestCode}</text>
            </box>
          </Show>
        </box>
      </scrollbox>

      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>↑/↓</span> scroll · <span style={{ fg: theme.text }}>esc</span> close
      </text>
    </box>
  )
}

DialogAlgorithmCode.show = (dialog: DialogContext, algorithm: Algorithm.Info) => {
  dialog.setSize("large")
  dialog.replace(
    () => <DialogAlgorithmCode algorithm={algorithm} />,
  )
}
