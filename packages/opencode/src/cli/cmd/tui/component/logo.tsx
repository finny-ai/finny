import { TextAttributes, RGBA } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { logo, tagline } from "@/cli/logo"

const TEAL = RGBA.fromHex("#00D4AA")

export function Logo() {
  const { theme } = useTheme()

  return (
    <box gap={1}>
      <box>
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row">
              <text fg={theme.textMuted} selectable={false}>
                {line}
              </text>
              <text fg={TEAL} attributes={TextAttributes.BOLD} selectable={false}>
                {logo.right[index()]}
              </text>
            </box>
          )}
        </For>
      </box>
      <box marginTop={1}>
        <text fg={theme.textMuted} selectable={false}>
          {tagline}
        </text>
        <text fg={theme.textMuted} selectable={false}>
          v0.6.7 • inspired by opencode
        </text>
      </box>
    </box>
  )
}
