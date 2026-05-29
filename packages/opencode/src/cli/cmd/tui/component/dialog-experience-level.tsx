import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { setExperienceLevel, type ExperienceLevel } from "../../../../../../finny-core/src/prefs"

export type DialogExperienceLevelProps = {
  onSelect?: (level: ExperienceLevel) => void
  onClose?: () => void
}

export function DialogExperienceLevel(props: DialogExperienceLevelProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const toast = useToast()

  const [focusIdx, setFocusIdx] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const choose = async (level: ExperienceLevel) => {
    if (busy()) return
    setBusy(true)
    try {
      await setExperienceLevel(level)
      props.onSelect?.(level)
      dialog.clear()
      props.onClose?.()
    } catch (e: any) {
      toast.show({
        variant: "error",
        message: `Couldn't save preference: ${e?.message ?? "unknown error"}`,
        duration: 4000,
      })
      setBusy(false)
    }
  }

  const OPTION_COUNT = 2
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
      choose(focusIdx() === 0 ? "trader" : "beginner")
    }
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  const Btn = (p: { label: string; sub: string; index: number; onClick: () => void }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={0}
      backgroundColor={focusIdx() === p.index ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
      onMouseOver={() => setFocusIdx(p.index)}
      onMouseUp={p.onClick}
    >
      <text
        fg={focusIdx() === p.index ? fg : theme.text}
        attributes={TextAttributes.BOLD}
      >
        {p.label}
      </text>
      <text fg={focusIdx() === p.index ? fg : theme.textMuted}>{p.sub}</text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        What brings you to Finny?
      </text>
      <text fg={theme.textMuted}>
        We'll tailor the default experience. You can change this any time in Settings.
      </text>

      <Btn
        label="I have a strategy to backtest or automate"
        sub="Build mode is your default. Scaffold, save, backtest, deploy."
        index={0}
        onClick={() => choose("trader")}
      />
      <Btn
        label="I'm new to trading, want to learn"
        sub="Chat mode is your default. We'll keep things conversational."
        index={1}
        onClick={() => choose("beginner")}
      />

      <text fg={theme.textMuted}>tab to switch · enter to confirm</text>
    </box>
  )
}

DialogExperienceLevel.show = (
  dialog: DialogContext,
  onSelect?: (level: ExperienceLevel) => void,
  onDismiss?: () => void,
) => {
  return new Promise<ExperienceLevel | null>((resolve) => {
    let chosen: ExperienceLevel | null = null
    dialog.replace(
      () => (
        <DialogExperienceLevel
          onSelect={(l) => {
            chosen = l
            onSelect?.(l)
          }}
          onClose={() => resolve(chosen)}
        />
      ),
      () => {
        onDismiss?.()
        resolve(chosen)
      },
    )
  })
}
