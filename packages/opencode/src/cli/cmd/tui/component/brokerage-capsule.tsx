import { createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { DialogBrokerage } from "./dialog-brokerage"

export function BrokerageCapsule() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()

  const label = createMemo(() => {
    const spec = local.brokerage.spec()
    if (!spec) return "Brokerage ▾"
    return `Brokerage: ${spec.displayName} ▾`
  })

  function open() {
    dialog.replace(() => <DialogBrokerage />)
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
      <text fg={theme.text}>{label()}</text>
    </box>
  )
}
