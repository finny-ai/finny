import type { JSX } from "solid-js"
import { useTheme } from "../context/theme"

export const RoundedBorder = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼",
}

type CardProps = {
  title?: string
  focused?: boolean
  flexGrow?: number
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`
  minHeight?: number
  padding?: number
  children?: JSX.Element
}

export function Card(props: CardProps) {
  const { theme } = useTheme()
  return (
    <box
      flexGrow={props.flexGrow}
      width={props.width}
      height={props.height}
      minHeight={props.minHeight}
      backgroundColor={theme.backgroundPanel}
      border={["top", "right", "bottom", "left"]}
      borderColor={props.focused ? theme.borderActive : theme.border}
      customBorderChars={RoundedBorder}
      flexDirection="column"
      flexShrink={1}
    >
      {props.title ? (
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <text fg={theme.textMuted} attributes={1}>
            {props.title}
          </text>
        </box>
      ) : null}
      <box
        flexGrow={1}
        paddingLeft={props.padding ?? 1}
        paddingRight={props.padding ?? 1}
        paddingTop={props.padding ?? 1}
        paddingBottom={props.padding ?? 1}
        flexDirection="column"
      >
        {props.children}
      </box>
    </box>
  )
}
