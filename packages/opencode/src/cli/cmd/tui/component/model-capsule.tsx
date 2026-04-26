import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"

export function ModelCapsule() {
  const { theme } = useTheme()
  const dialog = useDialog()

  function open() {
    dialog.replace(() => <DialogModel />)
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
      <text fg={theme.text}>Model ▾</text>
    </box>
  )
}
