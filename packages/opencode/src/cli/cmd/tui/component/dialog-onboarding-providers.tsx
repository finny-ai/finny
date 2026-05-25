import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

export type DialogOnboardingProvidersResult = "next" | "addProvider" | "dismissed"

export type DialogOnboardingProvidersProps = {
  onResult?: (result: Exclude<DialogOnboardingProvidersResult, "dismissed">) => void
  onClose?: () => void
}

const BUTTON_COUNT = 2 // [Add provider], [Next →]

export function DialogOnboardingProviders(props: DialogOnboardingProvidersProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const fg = selectedForeground(theme)

  const [focusIdx, setFocusIdx] = createSignal(1) // default focus on Next

  const connected = createMemo(() => {
    const ids = new Set(sync.data.provider_next.connected)
    return sync.data.provider_next.all.filter((p) => ids.has(p.id))
  })

  const choose = (result: Exclude<DialogOnboardingProvidersResult, "dismissed">) => {
    // Do NOT clear the dialog here. The orchestrator transitions the dialog
    // stack atomically (step1 → step2 or step1 → providerList) via
    // dialog.replace, so the stack never drops to 0 mid-flow. If we
    // clear()'d, the prompt input's createEffect (prompt/index.tsx:500)
    // would refocus during the empty-stack window and steal keystrokes —
    // the user could type behind the next dialog.
    props.onResult?.(result)
  }

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      const dir = evt.shift ? -1 : 1
      setFocusIdx((i) => (i + dir + BUTTON_COUNT) % BUTTON_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "left") {
      setFocusIdx((i) => (i - 1 + BUTTON_COUNT) % BUTTON_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "right") {
      setFocusIdx((i) => (i + 1) % BUTTON_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return") {
      choose(focusIdx() === 0 ? "addProvider" : "next")
    }
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  const Btn = (p: { label: string; index: number; onClick: () => void }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor={focusIdx() === p.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
      onMouseOver={() => setFocusIdx(p.index)}
      onMouseUp={p.onClick}
    >
      <text fg={focusIdx() === p.index ? fg : theme.text} attributes={TextAttributes.BOLD}>
        {p.label}
      </text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Providers (1 of 2)
      </text>
      <text fg={theme.textMuted}>
        Finny needs a model provider to think. Connect more any time from /settings.
      </text>

      <box paddingLeft={1} paddingRight={1} gap={0}>
        <Show
          when={connected().length > 0}
          fallback={<text fg={theme.textMuted}>No providers connected yet.</text>}
        >
          <For each={connected()}>
            {(p) => (
              <text fg={theme.text}>
                <span style={{ fg: theme.success }}>✓</span> {p.name}
              </text>
            )}
          </For>
        </Show>
      </box>

      <box flexDirection="row" gap={2} paddingBottom={1}>
        <Btn label="Add provider" index={0} onClick={() => choose("addProvider")} />
        <Btn label="Next →" index={1} onClick={() => choose("next")} />
      </box>

      <text fg={theme.textMuted}>tab to switch · enter to confirm · esc to skip</text>
    </box>
  )
}

DialogOnboardingProviders.show = (dialog: DialogContext) => {
  return new Promise<DialogOnboardingProvidersResult>((resolve) => {
    let picked: DialogOnboardingProvidersResult | null = null
    dialog.replace(
      () => (
        <DialogOnboardingProviders
          onResult={(r) => {
            if (picked !== null) return
            picked = r
            resolve(r)
          }}
        />
      ),
      () => {
        // Fires when escape pops us, or when the orchestrator replaces us
        // with the next dialog. If the user already picked, `picked` is
        // set — no-op. Otherwise this is an escape → dismissed.
        if (picked === null) {
          picked = "dismissed"
          resolve("dismissed")
        }
      },
    )
  })
}
