import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { Algorithm } from "@/algorithm"

export function AlgorithmCodeView(props: { algorithm: Algorithm.Info }) {
  const { theme } = useTheme()

  const updatedAt = () => {
    const d = new Date(props.algorithm.time_updated)
    return d.toLocaleDateString()
  }

  return (
    <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.algorithm.name}
        </text>
      </box>

      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.textMuted}>
          v{props.algorithm.version} · {props.algorithm.status} · {props.algorithm.language} · {updatedAt()}
        </text>
      </box>

      <Show when={props.algorithm.description}>
        <text fg={theme.textMuted}>{props.algorithm.description}</text>
      </Show>

      <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
        <box gap={1}>
          <box flexShrink={0}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              strategy.py
            </text>
          </box>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>{props.algorithm.code}</text>
          </box>

          <Show when={props.algorithm.config}>
            <box paddingTop={1} flexShrink={0}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                config.json
              </text>
            </box>
            <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{props.algorithm.config}</text>
            </box>
          </Show>

          <Show when={props.algorithm.backtestCode}>
            <box paddingTop={1} flexShrink={0}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                backtest.py
              </text>
            </box>
            <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{props.algorithm.backtestCode}</text>
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}
