import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { setExperienceLevel, type ExperienceLevel } from "@finny-ai/core/prefs"
import { ONBOARDING_BEGINNER_PROMPT, ONBOARDING_TRADER_PROMPT } from "./dialog-onboarding-prompts"

export type OnboardingPickedPath = {
  type: "picked"
  level: ExperienceLevel
  prompt: string
}

export type DialogOnboardingChoosePathResult =
  | OnboardingPickedPath
  | { type: "back" }
  | { type: "dismissed" }

export type DialogOnboardingChoosePathProps = {
  onResult?: (result: Exclude<DialogOnboardingChoosePathResult, { type: "dismissed" }>) => void
  onClose?: () => void
}

type OptionDef = {
  level: ExperienceLevel
  label: string
  sub: string
  prompt: string
}

const OPTIONS: OptionDef[] = [
  {
    level: "trader",
    label: "I have a strategy to backtest or automate",
    sub: "Build mode is your default. Scaffold, save, backtest, deploy.",
    prompt: ONBOARDING_TRADER_PROMPT,
  },
  {
    level: "beginner",
    label: "I'm new to trading, want to learn",
    sub: "Chat mode is your default. We'll keep things conversational.",
    prompt: ONBOARDING_BEGINNER_PROMPT,
  },
]

export function DialogOnboardingChoosePath(props: DialogOnboardingChoosePathProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const fg = selectedForeground(theme)
  const toast = useToast()

  const [focusIdx, setFocusIdx] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const hasProvider = createMemo(() => sync.data.provider_next.connected.length > 0)

  // Focus indices:
  //   if hasProvider:  [0] trader Ask, [1] beginner Ask
  //   else:           [0] back link,  [1] trader (disabled), [2] beginner (disabled)
  const focusCount = createMemo(() => (hasProvider() ? 2 : 3))

  const choose = async (opt: OptionDef) => {
    if (busy()) return
    if (!hasProvider()) return // guarded; should not be reachable
    setBusy(true)
    try {
      await setExperienceLevel(opt.level)
      // Do NOT clear here. The orchestrator handles the transition out
      // (clears the stack and navigates to a new session) so the prompt
      // input doesn't briefly re-focus and steal keystrokes.
      props.onResult?.({ type: "picked", level: opt.level, prompt: opt.prompt })
    } catch (e: any) {
      toast.show({
        variant: "error",
        message: `Couldn't save preference: ${e?.message ?? "unknown error"}`,
        duration: 4000,
      })
    } finally {
      setBusy(false)
    }
  }

  const goBack = () => {
    if (busy()) return
    // Atomic step2 → step1 transition is the orchestrator's job; just
    // signal here.
    props.onResult?.({ type: "back" })
  }

  useKeyboard((evt) => {
    if (busy()) return
    const count = focusCount()
    if (evt.name === "tab") {
      const dir = evt.shift ? -1 : 1
      setFocusIdx((i) => (i + dir + count) % count)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "down" || evt.name === "right") {
      setFocusIdx((i) => (i + 1) % count)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "up" || evt.name === "left") {
      setFocusIdx((i) => (i - 1 + count) % count)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return") {
      if (!hasProvider()) {
        if (focusIdx() === 0) goBack()
        return
      }
      void choose(OPTIONS[focusIdx()])
    }
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  const Card = (p: { opt: OptionDef; index: number }) => {
    const enabled = () => hasProvider() && !busy()
    return (
      <box
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={0}
        backgroundColor={focusIdx() === p.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
        onMouseOver={() => setFocusIdx(p.index)}
        onMouseUp={() => enabled() && void choose(p.opt)}
      >
        <text
          fg={focusIdx() === p.index && enabled() ? fg : enabled() ? theme.text : theme.textMuted}
          attributes={TextAttributes.BOLD}
        >
          {p.opt.label}
        </text>
        <text fg={focusIdx() === p.index && enabled() ? fg : theme.textMuted}>{p.opt.sub}</text>
      </box>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Try Finny (2 of 2)
      </text>
      <text fg={theme.textMuted}>
        Pick whichever fits. Finny will start a session and explain how it works for you.
      </text>

      <Show when={!hasProvider()}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={focusIdx() === 0 ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
          onMouseOver={() => setFocusIdx(0)}
          onMouseUp={goBack}
        >
          <text fg={focusIdx() === 0 ? fg : theme.text}>← Back: add a provider</text>
        </box>
      </Show>

      <Card opt={OPTIONS[0]} index={hasProvider() ? 0 : 1} />
      <Card opt={OPTIONS[1]} index={hasProvider() ? 1 : 2} />

      <text fg={theme.textMuted}>tab to switch · enter to confirm · esc to skip</text>
    </box>
  )
}

DialogOnboardingChoosePath.show = (dialog: DialogContext) => {
  return new Promise<DialogOnboardingChoosePathResult>((resolve) => {
    let picked: DialogOnboardingChoosePathResult | null = null
    dialog.replace(
      () => (
        <DialogOnboardingChoosePath
          onResult={(r) => {
            if (picked !== null) return
            picked = r
            resolve(r)
          }}
        />
      ),
      () => {
        // Escape from the dialog stack, or replaced by another dialog. If
        // a result is already picked, this is a no-op (re-resolving a
        // settled promise has no effect either way, but we still guard).
        if (picked === null) {
          picked = { type: "dismissed" }
          resolve(picked)
        }
      },
    )
  })
}
