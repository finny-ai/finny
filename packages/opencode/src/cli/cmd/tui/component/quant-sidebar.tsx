import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useDirectory } from "@tui/context/directory"
import { Installation } from "@/installation"

interface AgentStats {
  name: string
  symbol: string
  equity: number
  cash: number
  roi: number
  trades: number
  position: {
    quantity: number
    entry_price: number
    current_price: number
    pnl: number
    pnl_percent: number
  }
}

interface MarketPrices {
  [symbol: string]: {
    close: number
    open: number
    high: number
    low: number
    volume: number
  }
}

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

export function QuantSidebar(props: { sessionID: string; overlay?: boolean }) {
  const { theme } = useTheme()
  const directory = useDirectory()

  const [agents, setAgents] = createStore<AgentStats[]>([])
  const [prices, setPrices] = createStore<MarketPrices>({})
  const [connected, setConnected] = createSignal(false)
  const [arenaRunning, setArenaRunning] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const [expanded, setExpanded] = createStore({
    strategies: true,
    market: true,
  })

  let pollInterval: ReturnType<typeof setInterval> | null = null

  async function fetchStatus() {
    try {
      const response = await fetch(`${SIMULATOR_URL}/status`)
      if (!response.ok) throw new Error("Failed to fetch status")
      const data = await response.json()

      setConnected(true)
      setArenaRunning(data.running)
      setError(null)

      // Update agents
      const agentList: AgentStats[] = Object.entries(data.agents || {}).map(([name, agent]: [string, any]) => ({
        name,
        symbol: agent.symbol,
        equity: agent.equity,
        cash: agent.cash,
        roi: agent.roi,
        trades: agent.trades,
        position: agent.position,
      }))
      setAgents(agentList)
    } catch (err) {
      setConnected(false)
      setError("Cannot connect to simulator")
    }
  }

  async function fetchPrices() {
    try {
      const response = await fetch(`${SIMULATOR_URL}/prices`)
      if (!response.ok) return
      const data = await response.json()
      setPrices(data.prices || {})
    } catch {
      // Ignore price fetch errors
    }
  }

  onMount(() => {
    fetchStatus()
    fetchPrices()
    // Poll every 2 seconds for updates
    pollInterval = setInterval(() => {
      fetchStatus()
      fetchPrices()
    }, 2000)
  })

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval)
  })

  const totalEquity = createMemo(() => agents.reduce((sum, a) => sum + a.equity, 0))
  const totalPnL = createMemo(() => agents.reduce((sum, a) => sum + (a.equity - 10000), 0))
  const avgROI = createMemo(() => {
    if (agents.length === 0) return 0
    return agents.reduce((sum, a) => sum + a.roi, 0) / agents.length
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={42}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <scrollbox flexGrow={1}>
        <box flexShrink={0} gap={1} paddingRight={1}>
          {/* Header */}
          <box paddingRight={1}>
            <text fg={theme.text}>
              <b>Trading Arena</b>
            </text>
            <box flexDirection="row" gap={1}>
              <text fg={connected() ? theme.success : theme.error}>•</text>
              <text fg={theme.textMuted}>
                {connected() ? (arenaRunning() ? "Running" : "Stopped") : "Disconnected"}
              </text>
            </box>
          </box>

          {/* Error message */}
          <Show when={error()}>
            <box>
              <text fg={theme.error}>{error()}</text>
              <text fg={theme.textMuted}>Start simulator: python simulator/main.py</text>
            </box>
          </Show>

          {/* Summary Stats */}
          <Show when={connected() && agents.length > 0}>
            <box>
              <text fg={theme.text}>
                <b>Portfolio</b>
              </text>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.textMuted}>Total Equity</text>
                <text fg={theme.text}>${totalEquity().toFixed(2)}</text>
              </box>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.textMuted}>Total P&L</text>
                <text fg={totalPnL() >= 0 ? theme.success : theme.error}>
                  {totalPnL() >= 0 ? "+" : ""}${totalPnL().toFixed(2)}
                </text>
              </box>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.textMuted}>Avg ROI</text>
                <text fg={avgROI() >= 0 ? theme.success : theme.error}>
                  {avgROI() >= 0 ? "+" : ""}{avgROI().toFixed(2)}%
                </text>
              </box>
            </box>
          </Show>

          {/* Strategies */}
          <Show when={connected()}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => agents.length > 2 && setExpanded("strategies", !expanded.strategies)}
              >
                <Show when={agents.length > 2}>
                  <text fg={theme.text}>{expanded.strategies ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Strategies</b>
                  <span style={{ fg: theme.textMuted }}> ({agents.length})</span>
                </text>
              </box>
              <Show when={agents.length === 0}>
                <text fg={theme.textMuted}>No strategies deployed</text>
                <text fg={theme.textMuted}>Use /deploy to add one</text>
              </Show>
              <Show when={agents.length <= 2 || expanded.strategies}>
                <For each={agents}>
                  {(agent) => (
                    <box marginTop={1}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.text}>
                          <b>{agent.name}</b>
                        </text>
                        <text fg={agent.roi >= 0 ? theme.success : theme.error}>
                          {agent.roi >= 0 ? "+" : ""}{agent.roi.toFixed(2)}%
                        </text>
                      </box>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>{agent.symbol}</text>
                        <text fg={theme.textMuted}>${agent.equity.toFixed(2)}</text>
                      </box>
                      <text fg={theme.textMuted}>
                        {agent.trades} trades • {agent.position.quantity > 0 ? "LONG" : "FLAT"}
                      </text>
                      <Show when={agent.position.quantity > 0}>
                        <text fg={theme.textMuted}>
                          Entry: ${agent.position.entry_price.toFixed(2)} → ${agent.position.current_price.toFixed(2)}
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          {/* Market Prices */}
          <Show when={connected() && Object.keys(prices).length > 0}>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => Object.keys(prices).length > 5 && setExpanded("market", !expanded.market)}
              >
                <Show when={Object.keys(prices).length > 5}>
                  <text fg={theme.text}>{expanded.market ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>Market</b>
                </text>
              </box>
              <Show when={Object.keys(prices).length <= 5 || expanded.market}>
                <For each={Object.entries(prices)}>
                  {([symbol, price]) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>{symbol}</text>
                      <text fg={theme.text}>${price.close?.toFixed(2) ?? "N/A"}</text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>

          {/* Quick Commands */}
          <box marginTop={1}>
            <text fg={theme.text}>
              <b>Commands</b>
            </text>
            <text fg={theme.textMuted}>/deploy - Deploy strategy</text>
            <text fg={theme.textMuted}>/backtest - Test strategy</text>
            <text fg={theme.textMuted}>/status - View performance</text>
            <text fg={theme.textMuted}>/price - Get live price</text>
            <text fg={theme.textMuted}>/validate - Check code</text>
          </box>
        </box>
      </scrollbox>

      <box flexShrink={0} gap={1} paddingTop={1}>
        <text>
          <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
          <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
        </text>
        <text fg={theme.textMuted}>
          <span style={{ fg: connected() ? theme.success : theme.error }}>•</span>{" "}
          <span style={{ fg: theme.accent }}>
            <b>Finny</b>
          </span>{" "}
          {Installation.VERSION}
        </text>
      </box>
    </box>
  )
}
