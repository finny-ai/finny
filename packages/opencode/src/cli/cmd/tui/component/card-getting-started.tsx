import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogExamples } from "../ui/dialog-examples"
import { Card } from "./card"

// Compact 2-line first-run hint. Earlier versions of this card had 6+ lines
// of bullets and pushed the home logo / prompt off-screen on shorter
// terminals. This is intentionally tiny — the dense onboarding content
// lives in /examples (templates) and /help (full guide).
export function GettingStartedCard(props: { onDismiss?: () => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const openExamples = () => {
    dialog.setSize("large")
    dialog.replace(() => <DialogExamples />)
  }

  return (
    <Card title=" Getting started ">
      <box flexDirection="column" gap={0}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement} onMouseUp={openExamples}>
          <text fg={theme.text}>▸ Browse 7 templates</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>/help</span> for full guide
          </text>
          {props.onDismiss ? (
            <text fg={theme.textMuted} onMouseUp={props.onDismiss}>
              dismiss
            </text>
          ) : null}
        </box>
      </box>
    </Card>
  )
}
