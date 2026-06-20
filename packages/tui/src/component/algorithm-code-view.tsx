import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { Algorithm } from "@/algorithm"
import { parseConfig } from "@/algorithm/strategy-params"

export function AlgorithmCodeView(props: { algorithm: Algorithm.Info }) {
  const { theme } = useTheme()

  const updatedAt = () => {
    const d = new Date(props.algorithm.time_updated)
    return d.toLocaleDateString()
  }

  const prettyParams = () => {
    const parsed = parseConfig(props.algorithm.config)
    if (Object.keys(parsed).length === 0) return null
    return JSON.stringify(parsed, null, 2)
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

          <box paddingTop={1} flexShrink={0}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              strategy-params.json
            </text>
          </box>
          <text fg={theme.textMuted}>
            Captured from chat — read by the Backtest and Live Run dialogs as defaults.
          </text>
          <Show
            when={prettyParams()}
            fallback={
              <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
                <text fg={theme.textMuted}>
                  No params captured yet. Mention symbol, interval, equity, duration, or brokerage in chat and the agent will record them.
                </text>
              </box>
            }
          >
            <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{prettyParams()}</text>
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}
