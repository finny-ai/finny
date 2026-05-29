import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { setExperienceLevel, type ExperienceLevel } from "@finny-ai/core/prefs"

// Tone constraints (word cap, no jargon, vivid metaphor, etc.) live in
// the chat agent's FIRST IMPRESSIONS section, not here. These prompts
// are just what a real user would type.
export const ONBOARDING_TRADER_PROMPT =
  "Hi, I'm an experienced trader with strategies to backtest and automate. How does Finny work?"

export const ONBOARDING_BEGINNER_PROMPT =
  "Hi, I'm a trader. Help me understand what Finny does and how it can help me."

export type OnboardingPickedPath = {
  type: "picked"
  level: ExperienceLevel
  prompt: string
}

export type DialogOnboardingChoosePathResult = OnboardingPickedPath | { type: "dismissed" }

export type DialogOnboardingChoosePathProps = {
  onResult?: (result: DialogOnboardingChoosePathResult) => void
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

const OPTION_COUNT = 2

export function DialogOnboardingChoosePath(props: DialogOnboardingChoosePathProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const toast = useToast()

  const [focusIdx, setFocusIdx] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const choose = async (opt: OptionDef) => {
    if (busy()) return
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

  useKeyboard((evt) => {
    if (busy()) return
    if (evt.name === "tab") {
      const dir = evt.shift ? -1 : 1
      setFocusIdx((i) => (i + dir + OPTION_COUNT) % OPTION_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "down" || evt.name === "right") {
      setFocusIdx((i) => (i + 1) % OPTION_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "up" || evt.name === "left") {
      setFocusIdx((i) => (i - 1 + OPTION_COUNT) % OPTION_COUNT)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return") {
      void choose(OPTIONS[focusIdx()])
    }
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  const Card = (p: { opt: OptionDef; index: number }) => {
    const enabled = () => !busy()
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
        What brings you to Finny?
      </text>
      <text fg={theme.textMuted}>
        Pick whichever fits. Finny will start a session on a free model and explain how it works for you.
      </text>

      <Card opt={OPTIONS[0]} index={0} />
      <Card opt={OPTIONS[1]} index={1} />

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
        if (picked === null) {
          picked = { type: "dismissed" }
          resolve(picked)
        }
      },
    )
  })
}
