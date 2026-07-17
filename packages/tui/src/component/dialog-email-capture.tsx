import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, Show, onMount } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useKV } from "@tui/context/kv"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ConvexSubscriptions } from "@/storage/convex/subscriptions"
import { DeviceProfile } from "@/device"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type DialogEmailCaptureProps = {
  onClose?: () => void
  /** When false, hide skip/esc — used during first-launch onboarding. */
  allowSkip?: boolean
}

export function DialogEmailCapture(props: DialogEmailCaptureProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const toast = useToast()
  const kv = useKV()

  const allowSkip = () => props.allowSkip !== false
  const buttonCount = createMemo(() => (allowSkip() ? 3 : 2))

  const [email, setEmail] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [focusIdx, setFocusIdx] = createSignal(0) // 0 = input, 1 = submit, (2 = skip)
  let inputRef: InputRenderable | undefined

  const submit = async () => {
    const value = email().trim()
    if (!EMAIL_RE.test(value)) {
      toast.show({ variant: "warning", message: "That doesn't look like a valid email.", duration: 3000 })
      setFocusIdx(0)
      inputRef?.focus()
      return
    }
    setBusy(true)
    try {
      const device = await DeviceProfile.get().catch(() => undefined)
      await ConvexSubscriptions.subscribe({
        email: value.toLowerCase(),
        source: "tui_first_launch",
        version: InstallationVersion,
        platform: process.platform,
        deviceId: device?.userId,
      })
      kv.set("email_capture_status", "submitted")
      toast.show({ variant: "info", message: "Thanks — you're on the list.", duration: 3000 })
      props.onClose?.()
      dialog.clear()
    } catch (e: any) {
      toast.show({
        variant: "error",
        message: `Couldn't save: ${e?.message ?? "network error"}`,
        duration: 4000,
      })
      setBusy(false)
    }
  }

  const skip = () => {
    if (!allowSkip()) return
    kv.set("email_capture_status", "skipped")
    props.onClose?.()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (busy()) return
    if (evt.name === "escape") {
      if (allowSkip()) skip()
      evt.preventDefault?.()
      return
    }
    const count = buttonCount()
    if (evt.name === "tab") {
      const dir = evt.shift ? -1 : 1
      setFocusIdx((i) => {
        let next = (i + dir + count) % count
        if (next === 0) inputRef?.focus()
        else inputRef?.blur()
        return next
      })
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return") {
      const i = focusIdx()
      if (i === 0 || i === 1) void submit()
      else if (allowSkip()) skip()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => inputRef?.focus(), 1)
  })

  const Btn = (p: { label: string; index: number; onClick: () => void; primary?: boolean }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={focusIdx() === p.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
      onMouseOver={() => setFocusIdx(p.index)}
      onMouseUp={p.onClick}
    >
      <text
        fg={focusIdx() === p.index ? fg : p.primary ? theme.text : theme.textMuted}
        attributes={focusIdx() === p.index || p.primary ? TextAttributes.BOLD : undefined}
      >
        {p.label}
      </text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Stay in the loop?
        </text>
        <Show when={allowSkip()}>
          <text fg={theme.textMuted} onMouseUp={skip}>
            esc
          </text>
        </Show>
      </box>

      <text fg={theme.textMuted}>
        {allowSkip()
          ? "Drop your email for release notes. Optional — skip any time."
          : "Drop your email for release notes to continue."}
      </text>

      <box
        backgroundColor={theme.backgroundElement}
        paddingLeft={1}
        paddingRight={1}
        height={1}
        flexShrink={0}
      >
        <input
          ref={(r: InputRenderable) => (inputRef = r)}
          onInput={(v: string) => setEmail(v)}
          onMouseDown={function (this: any) {
            setFocusIdx(0)
            this?.focus?.()
          }}
          placeholder="you@example.com"
          placeholderColor={theme.textMuted}
          focusedBackgroundColor={theme.backgroundElement}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
        />
      </box>

      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <Show
          when={busy()}
          fallback={
            <>
              <Btn label="submit" index={1} onClick={() => void submit()} primary />
              <Show when={allowSkip()}>
                <Btn label="skip" index={2} onClick={skip} />
              </Show>
            </>
          }
        >
          <text fg={theme.textMuted}>saving…</text>
        </Show>
      </box>
    </box>
  )
}

DialogEmailCapture.show = (
  dialog: DialogContext,
  onDismiss?: () => void,
  options?: { allowSkip?: boolean },
) => {
  return new Promise<void>((resolve) => {
    const allowSkip = options?.allowSkip !== false
    dialog.replace(
      () => (
        <DialogEmailCapture
          allowSkip={allowSkip}
          onClose={() => resolve()}
        />
      ),
      () => {
        if (allowSkip) onDismiss?.()
        resolve()
      },
      { dismissible: allowSkip },
    )
  })
}
