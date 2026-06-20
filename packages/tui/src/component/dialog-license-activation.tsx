import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { License } from "@/license"
import { Spinner } from "@tui/component/spinner"
import { useExit } from "@tui/context/exit"
import { useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

export type DialogLicenseActivationResult = "activated" | "dismissed"

export function DialogLicenseActivation(props: { onResult?: (result: DialogLicenseActivationResult) => void }) {
  const dialog = useDialog()
  const exit = useExit()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [frame, setFrame] = createSignal(0)
  let textarea: TextareaRenderable
  const pulse = ["◇", "◈", "◆", "◈"]

  const activate = async () => {
    if (busy()) return
    const key = textarea?.plainText?.trim() ?? ""
    if (!key) {
      setError("Enter your Finny license key.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await License.activate(key)
      props.onResult?.("activated")
    } catch (e) {
      if (e instanceof License.AccessDeniedError) {
        setError(e.message || "Access denied. Please contact Finny.")
      } else {
        setError("Could not verify license. Please check your connection or contact Finny.")
      }
    } finally {
      setBusy(false)
    }
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      evt.preventDefault?.()
      evt.stopPropagation?.()
      void exit()
      return
    }
    if (busy()) {
      evt.preventDefault?.()
      evt.stopPropagation?.()
      return
    }
    if (evt.name === "return") {
      void activate()
      evt.preventDefault?.()
      evt.stopPropagation?.()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    const timer = setInterval(() => setFrame((current) => (current + 1) % pulse.length), 240)
    onCleanup(() => clearInterval(timer))
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (busy()) {
      textarea.traits = { suspend: true, status: "BUSY" }
      textarea.blur()
    } else {
      textarea.traits = {}
      textarea.focus()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            {pulse[frame()]}
          </text>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Activate Finny
          </text>
        </box>
        <text fg={theme.textMuted}>required</text>
      </box>

      <text fg={theme.textMuted}>
        Paste the enterprise license key for this workstation.
      </text>
      <text fg={theme.textMuted}>Only license and machine hashes are checked. Trading data stays local.</text>

      <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
        <textarea
          height={2}
          keyBindings={busy() ? [] : [{ name: "return", action: "submit" }]}
          onSubmit={() => void activate()}
          ref={(val: TextareaRenderable) => {
            textarea = val
          }}
          placeholder="finny_..."
          placeholderColor={theme.textMuted}
          textColor={busy() ? theme.textMuted : theme.text}
          focusedTextColor={busy() ? theme.textMuted : theme.text}
          cursorColor={busy() ? theme.backgroundElement : theme.text}
        />
      </box>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Show when={busy()}>
        <Spinner color={theme.textMuted}>Verifying license...</Spinner>
      </Show>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!busy()} fallback={<text fg={theme.textMuted}>verifying...</text>}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>verify</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

DialogLicenseActivation.show = (dialog: DialogContext) => {
  return new Promise<DialogLicenseActivationResult>((resolve) => {
    let picked: DialogLicenseActivationResult | null = null
    dialog.replace(
      () => (
        <DialogLicenseActivation
          onResult={(result) => {
            if (picked !== null) return
            picked = result
            resolve(result)
          }}
        />
      ),
      () => {
        if (picked !== null) return
        picked = "dismissed"
        resolve("dismissed")
      },
    )
  })
}
