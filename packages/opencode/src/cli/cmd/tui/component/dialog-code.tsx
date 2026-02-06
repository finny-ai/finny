import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface Strategy {
  name: string
  symbol: string
}

export function DialogCode() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [strategies, setStrategies] = createSignal<Strategy[]>([])
  const [selected, setSelected] = createSignal(0)
  const [code, setCode] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function fetchStrategies() {
    try {
      const response = await fetch(`${SIMULATOR_URL}/status`)
      const data = await response.json()
      const list: Strategy[] = Object.entries(data.agents || {}).map(([name, agent]: [string, any]) => ({
        name,
        symbol: agent.symbol,
      }))
      setStrategies(list)
    } catch {
      setError("Cannot connect to simulator")
    }
  }

  async function fetchCode(name: string) {
    setLoading(true)
    try {
      const response = await fetch(`${SIMULATOR_URL}/agent/${name}/code`)
      if (response.ok) {
        const data = await response.json()
        setCode(data.code)
      } else {
        setError("Strategy code not found")
      }
    } catch {
      setError("Failed to fetch code")
    }
    setLoading(false)
  }

  onMount(() => {
    fetchStrategies()
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      if (code()) {
        setCode(null)
      } else {
        dialog.clear()
      }
    } else if (!code()) {
      if (evt.name === "up" || evt.key === "k") {
        setSelected((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.key === "j") {
        setSelected((s) => Math.min(strategies().length - 1, s + 1))
      } else if (evt.name === "return") {
        const strat = strategies()[selected()]
        if (strat) fetchCode(strat.name)
      }
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {code() ? `Code: ${strategies()[selected()]?.name}` : "Strategy Code"}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>

      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading...</text>
      </Show>

      {/* Strategy list */}
      <Show when={!code() && !loading()}>
        <Show when={strategies().length === 0}>
          <text fg={theme.textMuted}>No strategies deployed</text>
        </Show>

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

        <text fg={theme.textMuted} marginTop={1}>
          <b>Enter</b> view code • <b>j/k</b> navigate • <b>esc</b> close
        </text>
      </Show>

      {/* Code view */}
      <Show when={code()}>
        <scrollbox maxHeight={20}>
          <box>
            <For each={code()!.split("\n")}>
              {(line, i) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted} width={4}>
                    {(i() + 1).toString().padStart(3)}
                  </text>
                  <text fg={theme.text}>{line}</text>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
        <text fg={theme.textMuted} marginTop={1}>
          <b>esc</b> back to list
        </text>
      </Show>
    </box>
  )
}
