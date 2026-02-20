import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

interface StrategyInfo {
  name: string
  symbol: string
}

export function DialogValidate() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [strategies, setStrategies] = createSignal<StrategyInfo[]>([])
  const [selected, setSelected] = createSignal(0)
  const [result, setResult] = createSignal<ValidationResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [validatingName, setValidatingName] = createSignal<string | null>(null)

  async function fetchStrategies() {
    setLoading(true)
    try {
      const response = await fetch(`${SIMULATOR_URL}/status`)
      const data = await response.json()
      const list: StrategyInfo[] = []
      for (const [name, agent] of Object.entries(data.agents || {})) {
        const a = agent as any
        list.push({ name, symbol: a.symbol || 'BTC' })
      }
      setStrategies(list)
      setError(null)
    } catch {
      setError("Cannot connect to simulator")
    }
    setLoading(false)
  }

  async function validateStrategy(name: string) {
    setLoading(true)
    setValidatingName(name)
    setResult(null)
    try {
      // First get the code
      const codeResponse = await fetch(`${SIMULATOR_URL}/agent/${name}/code`)
      if (!codeResponse.ok) {
        const err = await codeResponse.json()
        setError(err.error || 'Failed to get strategy code')
        setLoading(false)
        return
      }
      const codeData = await codeResponse.json()

      // Then validate it
      const validateResponse = await fetch(`${SIMULATOR_URL}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeData.code })
      })
      const validateData = await validateResponse.json()
      setResult({
        valid: validateData.valid,
        errors: validateData.errors || [],
        warnings: validateData.warnings || []
      })
      setError(null)
    } catch (err) {
      setError(`Validation failed: ${err}`)
    }
    setLoading(false)
  }

  onMount(() => {
    fetchStrategies()
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      if (result()) {
        setResult(null)
        setValidatingName(null)
      } else {
        dialog.clear()
      }
    } else if (evt.name === "return" && !result()) {
      const strat = strategies()[selected()]
      if (strat) {
        validateStrategy(strat.name).catch(() => {})
      }
    } else if (evt.name === "up" || evt.name === "k") {
      if (!result()) setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down" || evt.name === "j") {
      if (!result()) setSelected((s) => Math.min(strategies().length - 1, s + 1))
    } else if (evt.name === "r") {
      fetchStrategies()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Validate Strategy
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>

      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading...</text>
      </Show>

      <Show when={!loading() && strategies().length === 0 && !error()}>
        <text fg={theme.textMuted}>No strategies deployed</text>
        <text fg={theme.textMuted}>Deploy a strategy first, then validate it here</text>
      </Show>

      <Show when={!loading() && !result() && strategies().length > 0}>
        <text fg={theme.textMuted}>Select a strategy to validate:</text>
        <box>
          <For each={strategies()}>
            {(strat, i) => (
              <box
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={theme.text}>{strat.name}</text>
                <text fg={theme.textMuted}>{strat.symbol}</text>
              </box>
            )}
          </For>
        </box>
        <box marginTop={1}>
          <text fg={theme.text}>Validation checks:</text>
          <text fg={theme.textMuted}>• Syntax errors</text>
          <text fg={theme.textMuted}>• Required Strategy class structure</text>
          <text fg={theme.textMuted}>• Forbidden imports (os, subprocess, etc.)</text>
          <text fg={theme.textMuted}>• Lookahead bias detection</text>
        </box>
        <text fg={theme.textMuted} marginTop={1}>
          <b>enter</b> validate • <b>j/k</b> navigate • <b>r</b> refresh • <b>esc</b> close
        </text>
      </Show>

      <Show when={result()}>
        {(res) => (
          <>
            <text fg={theme.text}>
              Validating: <b>{validatingName()}</b>
            </text>
            <box flexDirection="row" gap={1} marginTop={1}>
              <text fg={res().valid ? theme.success : theme.error}>
                {res().valid ? "✓" : "✗"}
              </text>
              <text fg={theme.text}>
                {res().valid ? "Strategy is valid" : "Strategy has errors"}
              </text>
            </box>

            <Show when={res().errors.length > 0}>
              <box marginTop={1}>
                <text fg={theme.error}>Errors:</text>
                <For each={res().errors}>
                  {(err) => <text fg={theme.textMuted}>• {err}</text>}
                </For>
              </box>
            </Show>

            <Show when={res().warnings.length > 0}>
              <box marginTop={1}>
                <text fg={theme.warning}>Warnings:</text>
                <For each={res().warnings}>
                  {(warn) => <text fg={theme.textMuted}>• {warn}</text>}
                </For>
              </box>
            </Show>

            <text fg={theme.textMuted} marginTop={1}>
              <b>esc</b> back to list
            </text>
          </>
        )}
      </Show>
    </box>
  )
}
