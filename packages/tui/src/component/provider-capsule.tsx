import { createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { DialogProvider } from "./dialog-provider"

export function ProviderCapsule() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sync = useSync()

  const connectedCount = createMemo(() => sync.data.provider_next.connected.length)

  function open() {
    dialog.replace(() => <DialogProvider />)
  }

  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      border={["top", "right", "bottom", "left"]}
      borderColor={theme.border}
      onMouseUp={open}
    >
      <text fg={theme.text}>{`Provider${connectedCount() > 0 ? ` (${connectedCount()})` : ""} ▾`}</text>
    </box>
  )
}
