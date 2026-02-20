import { Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLocal, type PendingTransition } from "@tui/context/local"
import { useKeyboard } from "@opentui/solid"

export function TransitionPrompt() {
  const { theme } = useTheme()
  const local = useLocal()

  useKeyboard((evt) => {
    const pending = local.transition.pending()
    if (!pending) return

    if (evt.name === "return") {
      local.transition.confirm()
    } else if (evt.name === "escape") {
      local.transition.cancel()
    }
  })

  return (
    <Show when={local.transition.pending()}>
      {(transition) => (
        <box
          border={["single"] as any}
          borderColor={theme.accent}
          backgroundColor={theme.backgroundElement}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          marginTop={1}
          marginBottom={1}
        >
          <box flexDirection="row" gap={1}>
            <text fg={theme.accent} flexShrink={0}>
              →
            </text>
            <box>
              <text fg={theme.text}>
                <b>{transition().reason}</b>
              </text>
              <text fg={theme.textMuted}>
                Press <b style={{ fg: theme.text }}>Enter</b> to switch to{" "}
                <b style={{ fg: theme.accent }}>{transition().to}</b> mode
              </text>
              <text fg={theme.textMuted}>
                Press <b style={{ fg: theme.text }}>Escape</b> to stay in{" "}
                <b style={{ fg: theme.textMuted }}>{transition().from}</b> mode
              </text>
            </box>
          </box>
        </box>
      )}
    </Show>
  )
}
