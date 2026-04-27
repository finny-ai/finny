import { TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTheme } from "../context/theme"

type RouteHeaderProps = {
  icon: string[]
  title: string
  subtitle?: string
  meta?: string
  right?: JSX.Element
}

export function RouteHeader(props: RouteHeaderProps) {
  const { theme } = useTheme()

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      paddingTop={2}
      paddingBottom={2}
      paddingLeft={2}
      paddingRight={2}
      gap={3}
      border={["bottom"]}
      borderColor={theme.borderSubtle}
    >
      <box flexShrink={0} flexDirection="column">
        <For each={props.icon}>
          {(line) => (
            <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
          )}
        </For>
      </box>
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
          {props.title}
        </text>
        {props.subtitle ? (
          <text fg={theme.textMuted} selectable={false}>
            {props.subtitle}
          </text>
        ) : null}
        {props.meta ? (
          <box paddingTop={1}>
            <text fg={theme.textMuted} selectable={false}>
              {props.meta}
            </text>
          </box>
        ) : null}
      </box>
      {props.right ? (
        <box flexShrink={0} flexDirection="column" alignItems="flex-end">
          {props.right}
        </box>
      ) : null}
    </box>
  )
}

export const ROUTE_ICONS = {
  algorithms: ["  ▄██▄  ", " ██  ██ ", " ██▀▀██ ", " ▀▀  ▀▀ "],
  backtests: [" ▁      ", " █   ▁  ", " █ ▁ █  ", " █ █ █ ▁", " █ █ █ █"],
  portfolio: [" ▄████▄ ", "██ ▝▘ ██", "██ ╱╲ ██", " ▀████▀ "],
  sessions: [" ▄▄▄▄▄  ", "█  ●  █ ", "█▄▄▄▄▄█ ", "   ▀    "],
  settings: ["  ▄█▄   ", " █▀▀▀█  ", " █   █  ", "  ▀█▀   "],
} as const
