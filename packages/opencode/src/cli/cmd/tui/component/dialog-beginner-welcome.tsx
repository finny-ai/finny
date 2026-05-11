import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

// Static, no-model first conversation rendered for beginner users right after
// onboarding. Looks like a chat exchange so the UX is familiar, but the prompt
// and reply are hardcoded — nothing is sent to a model, no tokens are spent,
// and this works before the user has configured an API key.

const STATIC_USER_PROMPT = "I'm new to trading and want to learn."

const STATIC_REPLY = [
  "Honest answer: Finny isn't a trading tutorial — it's a tool for people",
  "who already have a strategy and want to test or automate it.",
  "",
  "If you're starting from zero, the fastest path is:",
  "",
  "  1. Learn the basics — Investopedia's \"Trading for Beginners\" guide,",
  "     or Khan Academy's \"Personal Finance\" series.",
  "  2. Paper-trade on Alpaca (free) for a few months to build intuition.",
  "  3. Come back when you can describe a strategy in 2–3 sentences,",
  "     e.g. \"buy SPY when 50d SMA > 200d, sell on crossover\".",
  "",
  "We're not going anywhere. You can still chat with Finny right now if",
  "you'd like — chat mode is your default.",
]

export type DialogBeginnerWelcomeProps = {
  onClose?: () => void
}

export function DialogBeginnerWelcome(props: DialogBeginnerWelcomeProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const [focusIdx, setFocusIdx] = createSignal(0)

  const close = () => {
    props.onClose?.()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "tab" || evt.name === "left" || evt.name === "right") {
      setFocusIdx((i) => (i + 1) % 2)
      evt.preventDefault?.()
      return
    }
    if (evt.name === "return" || evt.name === "escape") {
      close()
    }
  })

  onMount(() => {
    dialog.setSize("large")
  })

  const Btn = (p: { label: string; index: number; onClick: () => void }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={focusIdx() === p.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
      onMouseOver={() => setFocusIdx(p.index)}
      onMouseUp={p.onClick}
    >
      <text
        fg={focusIdx() === p.index ? fg : theme.text}
        attributes={focusIdx() === p.index ? TextAttributes.BOLD : undefined}
      >
        {p.label}
      </text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Welcome to Finny
      </text>

      <box paddingLeft={2} paddingRight={2} gap={0}>
        <text fg={theme.textMuted}>you</text>
        <text fg={theme.text}>{STATIC_USER_PROMPT}</text>
      </box>

      <box paddingLeft={2} paddingRight={2} gap={0}>
        <text fg={theme.textMuted}>finny</text>
        {STATIC_REPLY.map((line) => (
          <text fg={theme.text}>{line}</text>
        ))}
      </box>

      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <Btn label="got it" index={0} onClick={close} />
        <Btn label="open chat anyway" index={1} onClick={close} />
      </box>
    </box>
  )
}

DialogBeginnerWelcome.show = (dialog: DialogContext, onDismiss?: () => void) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogBeginnerWelcome onClose={() => resolve()} />,
      () => {
        onDismiss?.()
        resolve()
      },
    )
  })
}
