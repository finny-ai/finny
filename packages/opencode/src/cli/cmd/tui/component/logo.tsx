import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { logo } from "@/cli/logo"

const TEAL = "#00bfa5"

export function Logo() {
  const { theme } = useTheme()

  return (
    <box alignItems="center">
      <For each={logo.lines}>
        {(line) => {
          const before = line.slice(0, logo.yStart)
          const yPart = line.slice(logo.yStart)
          return (
            <box flexDirection="row">
              <text fg="#cccccc" attributes={TextAttributes.BOLD} selectable={false}>
                {before}
              </text>
              <text fg={TEAL} attributes={TextAttributes.BOLD} selectable={false}>
                {yPart}
              </text>
            </box>
          )
        }}
      </For>
      <box height={1} />
      <text fg={theme.textMuted} selectable={false}>
        {logo.tagline}
      </text>
      <text fg={theme.textMuted} selectable={false}>
        {logo.version}
      </text>
    </box>
  )
}
