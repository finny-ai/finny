import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface AgentStats {
  name: string
  symbol: string
  equity: number
  cash: number
  roi: number
  trades: number
  winning_trades: number
  total_fees: number
  peak_equity: number
  drawdown: number
  position: {
    quantity: number
    entry_price: number
    current_price: number
    pnl: number
    pnl_percent: number
  }
  trade_history: any[]
}

export function DialogStrategyStatus() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [agents, setAgents] = createSignal<AgentStats[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [arenaRunning, setArenaRunning] = createSignal(false)
  const [showCode, setShowCode] = createSignal(false)
  const [codeContent, setCodeContent] = createSignal<string | null>(null)
  const [codeScroll, setCodeScroll] = createSignal(0)

  async function fetchStatus() {
    setLoading(true)
    try {
      const response = await fetch(`${SIMULATOR_URL}/status`)
      const data = await response.json()
      setArenaRunning(data.running)

      // Fetch detailed stats for each agent
      const agentList: AgentStats[] = []
      for (const [name, agent] of Object.entries(data.agents || {})) {
        try {
          const statsResponse = await fetch(`${SIMULATOR_URL}/agent/${name}/stats`)
          if (statsResponse.ok) {
            const stats = await statsResponse.json()
            agentList.push(stats)
          } else {
            // Fallback to basic info
            const a = agent as any
            agentList.push({
              name,
              symbol: a.symbol,
              equity: a.equity,
              cash: a.cash,
              roi: a.roi,
              trades: a.trades,
              winning_trades: 0,
              total_fees: 0,
              peak_equity: a.equity,
              drawdown: 0,
              position: a.position,
              trade_history: [],
            })
          }
        } catch {
          // Use basic info on error
          const a = agent as any
          agentList.push({
            name,
            symbol: a.symbol,
            equity: a.equity,
            cash: a.cash,
            roi: a.roi,
            trades: a.trades,
            winning_trades: 0,
            total_fees: 0,
            peak_equity: a.equity,
            drawdown: 0,
            position: a.position,
            trade_history: [],
          })
        }
      }
      setAgents(agentList)
      setError(null)
    } catch {
      setError("Cannot connect to simulator")
    }
    setLoading(false)
  }

  onMount(() => {
    fetchStatus()
  })

  const selectedAgent = () => agents()[selected()]

  async function loadCode(strategyName: string) {
    try {
      const response = await fetch(`${SIMULATOR_URL}/agent/${strategyName}/code`)
      if (response.ok) {
        const data = await response.json()
        setCodeContent(data.code)
        setCodeScroll(0)
        setShowCode(true)
      } else {
        const error = await response.json()
        setCodeContent(`# Error: ${error.error || 'Failed to load strategy code'}`)
        setShowCode(true)
      }
    } catch (err) {
      setCodeContent(`# Error loading strategy: ${err}`)
      setShowCode(true)
    }
  }

  const codeLines = () => {
    const content = codeContent()
    if (!content) return []
    return content.split("\n")
  }

  const visibleLines = () => {
    const lines = codeLines()
    const scroll = codeScroll()
    const maxVisible = 20
    return lines.slice(scroll, scroll + maxVisible)
  }

  useKeyboard((evt) => {
    if (showCode()) {
      // Code view mode
      if (evt.name === "escape" || evt.name === "return") {
        setShowCode(false)
        setCodeContent(null)
      } else if (evt.name === "up" || evt.key === "k") {
        setCodeScroll((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.key === "j") {
        setCodeScroll((s) => Math.min(codeLines().length - 1, s + 1))
      }
    } else {
      // Strategy list mode
      if (evt.name === "escape") {
        dialog.clear()
      } else if (evt.name === "return") {
        const agent = selectedAgent()
        if (agent) {
          loadCode(agent.name).catch(() => {})
        }
      } else if (evt.name === "up" || evt.key === "k") {
        setSelected((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.key === "j") {
        setSelected((s) => Math.min(agents().length - 1, s + 1))
      } else if (evt.key === "r") {
        fetchStatus()
      }
    }
  })

  // Code view
  if (showCode()) {
    const agent = selectedAgent()
    return (
      <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {agent?.name || "Strategy"} Code
          </text>
          <text fg={theme.textMuted}>enter/esc to close</text>
        </box>

        <box>
          <For each={visibleLines()}>
            {(line, i) => (
              <text fg={theme.text}>
                <text fg={theme.textMuted}>{String(codeScroll() + i() + 1).padStart(3, " ")} </text>
                {line}
              </text>
            )}
          </For>
        </box>

        <Show when={codeLines().length > 20}>
          <text fg={theme.textMuted}>
            Lines {codeScroll() + 1}-{Math.min(codeScroll() + 20, codeLines().length)} of {codeLines().length}
          </text>
        </Show>

        <text fg={theme.textMuted} marginTop={1}>
          <b>j/k</b> scroll • <b>enter/esc</b> back
        </text>
      </box>
    )
  }

  // Strategy list view
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Strategy Status
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={arenaRunning() ? theme.success : theme.warning}>•</text>
        <text fg={theme.textMuted}>
          Arena {arenaRunning() ? "Running" : "Stopped"}
        </text>
      </box>

      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>

      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading...</text>
      </Show>

      <Show when={!loading() && agents().length === 0 && !error()}>
        <text fg={theme.textMuted}>No strategies deployed</text>
        <text fg={theme.textMuted}>Use /deploy to add one</text>
      </Show>

      <Show when={!loading() && agents().length > 0}>
        {/* Strategy list */}
        <box>
          <text fg={theme.text}>Strategies:</text>
          <For each={agents()}>
            {(agent, i) => (
              <box
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={theme.text}>{agent.name}</text>
                <text fg={agent.roi >= 0 ? theme.success : theme.error}>
                  {agent.roi >= 0 ? "+" : ""}{agent.roi.toFixed(2)}%
                </text>
              </box>
            )}
          </For>
        </box>

        {/* Selected strategy details */}
        <Show when={selectedAgent()}>
          {(agent) => (
            <box marginTop={1} gap={1}>
              <text fg={theme.text}>
                <b>{agent().name}</b> ({agent().symbol})
              </text>

              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Equity</text>
                  <text fg={theme.text}>${agent().equity.toFixed(2)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>P&L</text>
                  <text fg={agent().equity - 10000 >= 0 ? theme.success : theme.error}>
                    {agent().equity - 10000 >= 0 ? "+" : ""}${(agent().equity - 10000).toFixed(2)}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>ROI</text>
                  <text fg={agent().roi >= 0 ? theme.success : theme.error}>
                    {agent().roi >= 0 ? "+" : ""}{agent().roi.toFixed(2)}%
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Peak Equity</text>
                  <text fg={theme.text}>${agent().peak_equity.toFixed(2)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Drawdown</text>
                  <text fg={theme.error}>{agent().drawdown.toFixed(2)}%</text>
                </box>
              </box>

              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Total Trades</text>
                  <text fg={theme.text}>{agent().trades}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Winning Trades</text>
                  <text fg={theme.success}>{agent().winning_trades}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Win Rate</text>
                  <text fg={theme.text}>
                    {agent().trades > 0
                      ? ((agent().winning_trades / agent().trades) * 100).toFixed(1)
                      : 0}%
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Total Fees</text>
                  <text fg={theme.textMuted}>${agent().total_fees.toFixed(2)}</text>
                </box>
              </box>

              <Show when={agent().position.quantity > 0}>
                <box>
                  <text fg={theme.text}>Open Position:</text>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>Size</text>
                    <text fg={theme.text}>{agent().position.quantity.toFixed(4)}</text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>Entry</text>
                    <text fg={theme.text}>${agent().position.entry_price.toFixed(2)}</text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>Current</text>
                    <text fg={theme.text}>${agent().position.current_price.toFixed(2)}</text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>Unrealized P&L</text>
                    <text fg={agent().position.pnl >= 0 ? theme.success : theme.error}>
                      {agent().position.pnl >= 0 ? "+" : ""}${agent().position.pnl.toFixed(2)}
                      ({agent().position.pnl_percent >= 0 ? "+" : ""}{agent().position.pnl_percent.toFixed(2)}%)
                    </text>
                  </box>
                </box>
              </Show>
            </box>
          )}
        </Show>
      </Show>

      <text fg={theme.textMuted} marginTop={1}>
        <b>enter</b> view code • <b>r</b> refresh • <b>j/k</b> navigate • <b>esc</b> close
      </text>
    </box>
  )
}
