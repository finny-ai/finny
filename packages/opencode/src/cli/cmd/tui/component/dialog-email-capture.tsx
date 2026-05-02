import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Show, onMount } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useKV } from "@tui/context/kv"
import { Installation } from "@/installation"
import { ConvexSubscriptions } from "@/storage/convex/subscriptions"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type DialogEmailCaptureProps = {
  onClose?: () => void
}

export function DialogEmailCapture(props: DialogEmailCaptureProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const toast = useToast()
  const kv = useKV()

  const [email, setEmail] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [focusIdx, setFocusIdx] = createSignal(0) // 0 = input, 1 = submit, 2 = skip
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
      await ConvexSubscriptions.subscribe({
        email: value.toLowerCase(),
        source: "tui_first_launch",
        version: Installation.VERSION,
        platform: process.platform,
      })
      kv.set("email_capture_status", "submitted")
      // Intentionally NOT persisting the email address locally — it lives in
      // Convex (the source of truth) and we have no product use for a local
      // copy, so storing it would just be unnecessary PII retention.
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
    kv.set("email_capture_status", "skipped")
    props.onClose?.()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (busy()) return
    if (evt.name === "tab") {
      setFocusIdx((i) => {
        const next = (i + (evt.shift ? 2 : 1)) % 3
        if (next === 0) inputRef?.focus()
        else inputRef?.blur()
        return next
      })
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return") {
      const i = focusIdx()
      if (i === 0 || i === 1) submit()
      else skip()
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
        <text fg={theme.textMuted} onMouseUp={skip}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>
        Drop your email for release notes. Optional — skip any time.
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
        <Show when={busy()} fallback={
          <>
            <Btn label="submit" index={1} onClick={submit} primary />
            <Btn label="skip" index={2} onClick={skip} />
          </>
        }>
          <text fg={theme.textMuted}>saving…</text>
        </Show>
      </box>
    </box>
  )
}

DialogEmailCapture.show = (dialog: DialogContext, onDismiss?: () => void) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogEmailCapture onClose={() => resolve()} />,
      () => {
        onDismiss?.()
        resolve()
      },
    )
  })
}
