import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import open from "open"
import { createSignal } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

const PRO_URL = "https://finnyai.tech/pro"

export type DialogProUpsellProps = {
  message: string
  onClose?: () => void
}

export function DialogProUpsell(props: DialogProUpsellProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const [selected, setSelected] = createSignal(0)

  const upgrade = () => {
    open(PRO_URL).catch(() => {})
    props.onClose?.()
    dialog.clear()
  }

  const dismiss = () => {
    props.onClose?.()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
      setSelected((s) => (s === 0 ? 1 : 0))
      return
    }
    if (evt.name !== "return") return
    if (selected() === 0) upgrade()
    else dismiss()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Pro feature
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1} paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
        <text fg={theme.textMuted}>
          Upgrade to Finny Pro at{" "}
          <span style={{ fg: theme.primary }}>finnyai.tech/pro</span>
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={selected() === 0 ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
          onMouseOver={() => setSelected(0)}
          onMouseUp={upgrade}
        >
          <text
            fg={selected() === 0 ? fg : theme.text}
            attributes={selected() === 0 ? TextAttributes.BOLD : undefined}
          >
            upgrade
          </text>
        </box>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={selected() === 1 ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
          onMouseOver={() => setSelected(1)}
          onMouseUp={dismiss}
        >
          <text
            fg={selected() === 1 ? fg : theme.textMuted}
            attributes={selected() === 1 ? TextAttributes.BOLD : undefined}
          >
            close
          </text>
        </box>
      </box>
    </box>
  )
}

DialogProUpsell.show = (dialog: DialogContext, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogProUpsell message={message} onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
