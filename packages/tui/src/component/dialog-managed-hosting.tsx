import { TextAttributes, MouseEvent } from "@opentui/core"
import { createSignal, For, onMount, Show } from "solid-js"
import open from "open"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useKeyboard } from "@opentui/solid"
import { Algorithm } from "@/algorithm"

const HOSTING_EMAIL = "jaimin@finnyai.tech"

const TERMS = `MANAGED HOSTING TERMS & CONDITIONS

By requesting managed hosting through Finny, you acknowledge and agree to the following:

1. HOSTING ONLY — Finny provides server infrastructure to run your algorithm. Finny does not create, modify, manage, or make trading decisions on your behalf.

2. YOUR ALGORITHM, YOUR RESPONSIBILITY — The algorithm being hosted was created by you. All trading logic, parameters, and decisions are entirely yours.

3. NO ACCESS — Finny will not access, monitor, or interfere with your algorithm's trading activity beyond what is necessary to keep the server running.

4. PROFITS AND LOSSES — All profits, gains, losses, and liabilities arising from your algorithm's activity are entirely yours. Finny has no claim to any profits and bears no responsibility for any losses.

5. NO FINANCIAL ADVICE — Finny is not a financial advisor, broker, or investment manager. Nothing provided by Finny constitutes financial, investment, or trading advice.

6. NO LIABILITY — Finny is not liable for any financial losses, missed trades, system downtime, data loss, or any other damages arising from the use of managed hosting.

7. TERMINATION — Either party may terminate the hosting arrangement at any time. Finny reserves the right to stop hosting your algorithm with reasonable notice.

By clicking "I agree & send request" you confirm that you have read, understood, and agree to these terms.`

function guessSymbolForAlgo(algo: Algorithm.Info): string {
  if (algo.config) {
    try {
      const c = JSON.parse(algo.config)
      if (typeof c?.symbol === "string") return c.symbol
    } catch {}
  }
  const code = algo.code || ""
  const m1 = code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
  if (m1) return m1[1]
  const stop = new Set([
    "INTRADAY", "HYBRID", "MOMENTUM", "MEAN", "REVERSION", "BREAKOUT",
    "STRATEGY", "ALGO", "V1", "V2", "V3", "V4", "V5",
  ])
  for (const t of (algo.name || "").toUpperCase().split(/[-_\s.]+/)) {
    if (!t || stop.has(t)) continue
    if (/^[A-Z][A-Z0-9]{0,4}$/.test(t)) return t
  }
  return "AAPL"
}

function guessIntervalForAlgo(algo: Algorithm.Info): string {
  if (algo.config) {
    try {
      const c = JSON.parse(algo.config)
      if (typeof c?.interval === "string") return c.interval
    } catch {}
  }
  const m = (algo.code || "").match(/INTERVAL\s*=\s*["']([^"']+)["']/)
  if (m) return m[1]
  return "1min"
}

export type DialogManagedHostingProps = {
  onClose?: () => void
}

export function DialogManagedHosting(props: DialogManagedHostingProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const toast = useToast()

  const [algorithms, setAlgorithms] = createSignal<Algorithm.Info[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(-1)
  const [symbol, setSymbol] = createSignal("")
  const [interval, setInterval] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [agreed, setAgreed] = createSignal(false)
  const [showTerms, setShowTerms] = createSignal(false)

  const selectedAlgo = () => {
    const idx = selectedIndex()
    const algos = algorithms()
    return idx >= 0 && idx < algos.length ? algos[idx] : null
  }

  onMount(async () => {
    dialog.setSize("large")
    try {
      const algos = await Algorithm.list()
      setAlgorithms(algos)
    } catch {
      setAlgorithms([])
    }
  })

  const selectAlgo = (index: number) => {
    setSelectedIndex(index)
    const algo = algorithms()[index]
    if (algo) {
      setSymbol(guessSymbolForAlgo(algo))
      setInterval(guessIntervalForAlgo(algo))
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      if (showTerms()) {
        setShowTerms(false)
        evt.preventDefault()
        return
      }
      props.onClose?.()
      dialog.clear()
    }
  })

  const submit = () => {
    const algo = selectedAlgo()
    if (!algo) {
      toast.show({ message: "Please select an algorithm", variant: "warning", duration: 3000 })
      return
    }
    const contact = email().trim()
    if (!contact) {
      toast.show({ message: "Please enter your contact email", variant: "warning", duration: 3000 })
      return
    }
    if (!agreed()) {
      toast.show({ message: "Please read and agree to the terms & conditions", variant: "warning", duration: 3000 })
      return
    }

    const subject = encodeURIComponent(`Managed Hosting Request - ${algo.name}`)
    const body = encodeURIComponent(
      `Hi Finny team,\n\n` +
        `I'd like to request managed hosting for my algorithm.\n\n` +
        `Algorithm: ${algo.name}\n` +
        `Symbol: ${symbol()}\n` +
        `Interval: ${interval()}\n` +
        `Contact email: ${contact}\n\n` +
        `I have read and agreed to the Managed Hosting Terms & Conditions.\n\n` +
        `Thanks!`,
    )

    const mailto = `mailto:${HOSTING_EMAIL}?subject=${subject}&body=${body}`
    open(mailto).catch(() => {
      toast.show({ message: `Email: ${HOSTING_EMAIL}`, variant: "info", duration: 5000 })
    })
    toast.show({ message: "Email draft opened — send it to request managed hosting", variant: "info", duration: 4000 })
    props.onClose?.()
    dialog.clear()
  }

  const InputBox = (inputProps: { value?: string; onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
        value={inputProps.value}
        onInput={(v: string) => inputProps.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Request Managed Hosting
        </text>
        <text fg={theme.textMuted} onMouseUp={() => { props.onClose?.(); dialog.clear() }}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>
        We'll deploy your algo on our infrastructure with a Telegram bot for monitoring.
      </text>

      {/* Terms view */}
      <Show when={showTerms()}>
        <box
          border={["top", "bottom"]}
          borderColor={theme.border}
          paddingTop={1}
          paddingBottom={1}
          height={16}
          flexShrink={0}
        >
          <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
            <text fg={theme.textMuted}>{TERMS}</text>
          </scrollbox>
        </box>
        <box flexDirection="row" gap={2}>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.primary}
            onMouseUp={() => { setAgreed(true); setShowTerms(false) }}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              I agree
            </text>
          </box>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.backgroundElement}
            onMouseUp={() => setShowTerms(false)}
          >
            <text fg={theme.text}>Back</text>
          </box>
        </box>
      </Show>

      {/* Main form */}
      <Show when={!showTerms()}>
        {/* Algorithm picker */}
        <text fg={theme.textMuted}>Select algorithm</text>
        <Show
          when={algorithms().length > 0}
          fallback={<text fg={theme.warning}>No algorithms found. Create one first.</text>}
        >
          <box flexDirection="column" gap={0} flexShrink={0}>
            <For each={algorithms()}>
              {(algo, i) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selectedIndex() === i() ? theme.primary : theme.backgroundElement}
                  onMouseUp={() => selectAlgo(i())}
                  flexDirection="row"
                  gap={2}
                >
                  <text
                    fg={selectedIndex() === i() ? theme.background : theme.text}
                    attributes={selectedIndex() === i() ? TextAttributes.BOLD : undefined}
                  >
                    {algo.name}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        {/* Auto-filled symbol & interval */}
        <Show when={selectedAlgo()}>
          <box flexDirection="row" gap={4} flexShrink={0}>
            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted}>Symbol</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{symbol()}</text>
            </box>
            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted}>Interval</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{interval()}</text>
            </box>
          </box>
        </Show>

        {/* Contact email */}
        <text fg={theme.textMuted}>Your contact email</text>
        <InputBox onInput={setEmail} />

        {/* Terms checkbox */}
        <box flexDirection="row" gap={1} flexShrink={0} paddingTop={1}>
          <box onMouseUp={() => agreed() ? setAgreed(false) : setShowTerms(true)}>
            <text fg={agreed() ? theme.success : theme.textMuted} attributes={TextAttributes.BOLD}>
              {agreed() ? "[x]" : "[ ]"}
            </text>
          </box>
          <text fg={theme.textMuted}>
            I agree to the{" "}
          </text>
          <text
            fg={theme.primary}
            onMouseUp={() => setShowTerms(true)}
          >
            terms & conditions
          </text>
        </box>

        {/* Submit */}
        <box paddingTop={1} flexDirection="row">
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={agreed() && selectedAlgo() ? theme.primary : theme.borderSubtle}
            onMouseUp={submit}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              → I agree & send request
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

DialogManagedHosting.show = (dialog: DialogContext) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogManagedHosting onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
