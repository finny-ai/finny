import { For, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  badge?: string
}

export function SegmentedControl<T extends string>(props: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  gap?: number
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={props.gap ?? 4} flexShrink={0}>
      <For each={props.options}>
        {(opt) => {
          const isActive = () => props.value === opt.value
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              paddingBottom={1}
              border={["bottom"]}
              borderColor={isActive() ? theme.primary : theme.background}
              onMouseUp={() => props.onChange(opt.value)}
            >
              <text
                fg={isActive() ? theme.text : theme.textMuted}
                attributes={isActive() ? TextAttributes.BOLD : 0}
              >
                {opt.label}
                {opt.badge ? ` ${opt.badge}` : ""}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
