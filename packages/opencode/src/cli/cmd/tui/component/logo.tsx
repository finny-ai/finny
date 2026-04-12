import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { logo } from "@/cli/logo"

type LogoProps = {
  variant?: "full" | "compact"
}

export function Logo(props: LogoProps) {
  const { theme } = useTheme()
  const isCompact = () => props.variant === "compact"

  return (
    <box alignItems={isCompact() ? "flex-start" : "center"}>
      <Show
        when={!isCompact()}
        fallback={
          <box flexDirection="row" gap={1}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
              FINNY
            </text>
            <text fg={theme.textMuted} selectable={false}>
              {logo.version}
            </text>
          </box>
        }
      >
        <For each={logo.lines}>
          {(line) => (
            <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
          )}
        </For>
        <box height={1} />
        <text fg={theme.textMuted} selectable={false}>
          {logo.tagline}
        </text>
        <text fg={theme.textMuted} selectable={false}>
          {logo.version}
        </text>
      </Show>
    </box>
  )
}
