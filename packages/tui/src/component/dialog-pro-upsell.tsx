import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import open from "open"
import { createSignal, Show } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { Plan } from "@/plan"

const PRO_URL = "https://finnyai.tech/pro"
const LITE_URL = "https://finnyai.tech/lite"

export type DialogProUpsellProps = {
  message: string
  requiredTier?: Plan.Tier
  onClose?: () => void
}

export function DialogProUpsell(props: DialogProUpsellProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const [selected, setSelected] = createSignal(0)

  const required = (): Plan.Tier => props.requiredTier ?? "pro"
  // Two-button mode when Lite suffices but we want to also offer Pro.
  const showBothTiers = (): boolean => required() === "lite"

  const openUrl = (url: string) => {
    open(url).catch(() => {})
    props.onClose?.()
    dialog.clear()
  }

  const upgradeLite = () => openUrl(LITE_URL)
  const upgradePro = () => openUrl(PRO_URL)
  const dismiss = () => {
    props.onClose?.()
    dialog.clear()
  }

  // Button order: lite-mode → [Upgrade Lite, Upgrade Pro, close]; pro-mode → [Upgrade Pro, close]
  const buttonCount = () => (showBothTiers() ? 3 : 2)

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
      setSelected((s) => (s + 1) % buttonCount())
      return
    }
    if (evt.name !== "return") return
    if (showBothTiers()) {
      if (selected() === 0) upgradeLite()
      else if (selected() === 1) upgradePro()
      else dismiss()
    } else {
      if (selected() === 0) upgradePro()
      else dismiss()
    }
  })

  const titleText = () => (required() === "lite" ? "Paid feature" : "Pro feature")

  const Button = (props: {
    label: string
    index: number
    onClick: () => void
    primary?: boolean
  }) => (
    <box
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={selected() === props.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
      onMouseOver={() => setSelected(props.index)}
      onMouseUp={props.onClick}
    >
      <text
        fg={selected() === props.index ? fg : props.primary ? theme.text : theme.textMuted}
        attributes={selected() === props.index || props.primary ? TextAttributes.BOLD : undefined}
      >
        {props.label}
      </text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {titleText()}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1} paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
        <Show when={showBothTiers()} fallback={
          <text fg={theme.textMuted}>
            Upgrade to Finny Pro at{" "}
            <span style={{ fg: theme.primary }}>finnyai.tech/pro</span>
          </text>
        }>
          <text fg={theme.textMuted}>
            Get Finny Lite at{" "}
            <span style={{ fg: theme.primary }}>finnyai.tech/lite</span>
            , or unlock everything with Pro at{" "}
            <span style={{ fg: theme.primary }}>finnyai.tech/pro</span>
            .
          </text>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <Show when={showBothTiers()}>
          <Button label="upgrade to lite" index={0} onClick={upgradeLite} primary />
          <Button label="get pro" index={1} onClick={upgradePro} />
          <Button label="close" index={2} onClick={dismiss} />
        </Show>
        <Show when={!showBothTiers()}>
          <Button label="upgrade" index={0} onClick={upgradePro} primary />
          <Button label="close" index={1} onClick={dismiss} />
        </Show>
      </box>
    </box>
  )
}

DialogProUpsell.show = (
  dialog: DialogContext,
  message: string,
  requiredTier: Plan.Tier = "pro",
) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => (
        <DialogProUpsell
          message={message}
          requiredTier={requiredTier}
          onClose={() => resolve()}
        />
      ),
      () => resolve(),
    )
  })
}
