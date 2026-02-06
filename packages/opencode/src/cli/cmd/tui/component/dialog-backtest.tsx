import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

interface StrategyInfo {
  name: string
  symbol: string
  deployed: boolean
  roi?: number
}

interface BacktestConfig {
  period: string
  interval: string
  capital: number
}

interface BacktestResult {
  starting_capital: number
  ending_equity: number
  total_return: number
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number
  max_drawdown: number
  total_fees: number
  avg_win: number
  avg_loss: number
  profit_factor: number
  symbol: string
  period: string
  interval: string
  bars_processed: number
}

type Step = "select" | "configure" | "running" | "results"

const PERIODS = [
  { label: "1 month", value: "1m" },
  { label: "3 months", value: "3m" },
  { label: "6 months", value: "6m" },
  { label: "1 year", value: "1y" },
]

const INTERVALS = [
  { label: "1 hour", value: "1h" },
  { label: "4 hours", value: "4h" },
  { label: "1 day", value: "1d" },
]

export interface DialogBacktestProps {
  initialStrategy?: string
}

export function DialogBacktest(props: DialogBacktestProps = {}) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [step, setStep] = createSignal<Step>(props.initialStrategy ? "configure" : "select")
  const [strategies, setStrategies] = createSignal<StrategyInfo[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Config state
  const [configIndex, setConfigIndex] = createSignal(0)
  const [periodIndex, setPeriodIndex] = createSignal(1) // Default to 3 months
  const [intervalIndex, setIntervalIndex] = createSignal(0) // Default to 1 hour
  const [capital, setCapital] = createSignal(10000)

  // Results state
  const [result, setResult] = createSignal<BacktestResult | null>(null)
  // Initialize selectedStrategy with initial strategy info if provided
  const [selectedStrategy, setSelectedStrategy] = createSignal<StrategyInfo | null>(
    props.initialStrategy ? { name: props.initialStrategy, symbol: "BTC", deployed: false } : null
  )

  async function fetchStrategies() {
    setLoading(true)
    setError(null)
    try {
      // Fetch deployed strategies from /status
      const statusResponse = await fetch(`${SIMULATOR_URL}/status`)
      const statusData = await statusResponse.json()

      const deployed: StrategyInfo[] = []
      for (const [name, agent] of Object.entries(statusData.agents || {})) {
        const a = agent as any
        deployed.push({
          name,
          symbol: a.symbol || "BTC",
          deployed: true,
          roi: a.roi,
        })
      }

      // Fetch all strategy files from /strategies
      try {
        const strategiesResponse = await fetch(`${SIMULATOR_URL}/strategies`)
        if (strategiesResponse.ok) {
          const strategiesData = await strategiesResponse.json()
          const files = strategiesData.strategies || []

          // Add non-deployed strategies
          for (const file of files) {
            const name = file.name || file
            if (!deployed.find((d) => d.name === name)) {
              deployed.push({
                name,
                symbol: file.symbol || "Unknown",
                deployed: false,
              })
            }
          }
        }
      } catch {
        // Ignore errors fetching strategy files
      }

      setStrategies(deployed)
    } catch {
      setError("Cannot connect to simulator")
    }
    setLoading(false)
  }

  async function runBacktest() {
    const strat = strategies()[selected()]
    if (!strat) return

    setSelectedStrategy(strat)
    setStep("running")
    setError(null)

    try {
      const response = await fetch(`${SIMULATOR_URL}/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: strat.name,
          symbol: strat.symbol !== "Unknown" ? strat.symbol : undefined,
          period: PERIODS[periodIndex()].value,
          interval: INTERVALS[intervalIndex()].value,
          capital: capital(),
        }),
      })

      // Get raw text first to handle non-JSON responses
      const text = await response.text()

      let data
      try {
        data = JSON.parse(text)
      } catch {
        console.error("Invalid JSON response:", text.substring(0, 500))
        setError("Simulator returned invalid response. Check if it's running.")
        setStep("configure")
        return
      }

      if (!response.ok) {
        setError(data.error || `Backtest failed (${response.status})`)
        setStep("configure")
        return
      }

      setResult(data)
      setStep("results")

      // Track successful backtest in localStorage
      try {
        const backtested = JSON.parse(localStorage.getItem('finny_backtested_strategies') || '[]')
        if (!backtested.includes(strat.name)) {
          backtested.push(strat.name)
          localStorage.setItem('finny_backtested_strategies', JSON.stringify(backtested))
        }
      } catch {
        // Ignore localStorage errors
      }
    } catch (err: any) {
      if (err.message?.includes("fetch")) {
        setError("Cannot connect to simulator. Is it running?")
      } else {
        setError(`Backtest failed: ${err.message || err}`)
      }
      setStep("configure")
    }
  }

  onMount(() => {
    fetchStrategies()
  })

  const currentConfig = createMemo(() => {
    return {
      period: PERIODS[periodIndex()],
      interval: INTERVALS[intervalIndex()],
      capital: capital(),
    }
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      if (step() === "results") {
        setStep("select")
        setResult(null)
        setError(null)
      } else if (step() === "configure") {
        setStep("select")
        setError(null)
      } else {
        dialog.clear()
      }
      return
    }

    if (step() === "select") {
      if (evt.name === "return" || evt.name === "enter") {
        const strats = strategies()
        const idx = selected()
        const strat = strats[idx]
        console.log("Enter pressed, strategies:", strats.length, "selected:", idx, "strat:", strat?.name)
        if (strat) {
          setSelectedStrategy(strat)
          setStep("configure")
        }
      } else if (evt.name === "up" || evt.key === "k") {
        setSelected((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.key === "j") {
        setSelected((s) => Math.min(strategies().length - 1, s + 1))
      } else if (evt.key === "r") {
        fetchStrategies()
      }
    } else if (step() === "configure") {
      if (evt.name === "return") {
        runBacktest()
      } else if (evt.name === "up" || evt.key === "k") {
        setConfigIndex((i) => Math.max(0, i - 1))
      } else if (evt.name === "down" || evt.key === "j") {
        setConfigIndex((i) => Math.min(2, i + 1))
      } else if (evt.name === "left" || evt.key === "h") {
        if (configIndex() === 0) {
          setPeriodIndex((i) => Math.max(0, i - 1))
        } else if (configIndex() === 1) {
          setIntervalIndex((i) => Math.max(0, i - 1))
        } else if (configIndex() === 2) {
          setCapital((c) => Math.max(1000, c - 1000))
        }
      } else if (evt.name === "right" || evt.key === "l") {
        if (configIndex() === 0) {
          setPeriodIndex((i) => Math.min(PERIODS.length - 1, i + 1))
        } else if (configIndex() === 1) {
          setIntervalIndex((i) => Math.min(INTERVALS.length - 1, i + 1))
        } else if (configIndex() === 2) {
          setCapital((c) => Math.min(1000000, c + 1000))
        }
      }
    } else if (step() === "results") {
      if (evt.name === "return") {
        dialog.clear()
      }
    }
  })

  return (
    <>
      {/* Step: Select Strategy */}
      <Show when={step() === "select"}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Backtest Strategy
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
            <text fg={theme.textMuted}>No strategies found</text>
            <text fg={theme.textMuted}>Create a strategy file or deploy one first</text>
          </Show>

          <Show when={!loading() && strategies().length > 0}>
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
                    <text fg={theme.text}>
                      <span style={{ fg: strat.deployed ? theme.success : theme.textMuted }}>
                        {strat.deployed ? "\u25cf" : "\u25cb"}
                      </span>{" "}
                      {strat.name}
                      <span style={{ fg: theme.textMuted }}> ({strat.symbol})</span>
                    </text>
                    <Show when={strat.deployed && strat.roi !== undefined}>
                      <text fg={strat.roi! >= 0 ? theme.success : theme.error}>
                        {strat.roi! >= 0 ? "+" : ""}{strat.roi!.toFixed(2)}%
                      </text>
                    </Show>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <text fg={theme.textMuted} marginTop={1}>
            <b>enter</b> select <b>r</b> refresh <b>j/k</b> nav
          </text>
        </box>
      </Show>

      {/* Step: Configure */}
      <Show when={step() === "configure"}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Configure Backtest
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>

          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>

          <text fg={theme.textMuted}>
            Strategy: <span style={{ fg: theme.text }}>{selectedStrategy()?.name}</span>
          </text>

          <box marginTop={1}>
            <box
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={configIndex() === 0 ? theme.backgroundElement : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={configIndex() === 0 ? theme.accent : theme.textMuted}>
                {configIndex() === 0 ? "\u25b6" : " "} Period
              </text>
              <text fg={theme.text}>{currentConfig().period.label}</text>
            </box>
            <box
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={configIndex() === 1 ? theme.backgroundElement : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={configIndex() === 1 ? theme.accent : theme.textMuted}>
                {configIndex() === 1 ? "\u25b6" : " "} Interval
              </text>
              <text fg={theme.text}>{currentConfig().interval.label}</text>
            </box>
            <box
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={configIndex() === 2 ? theme.backgroundElement : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={configIndex() === 2 ? theme.accent : theme.textMuted}>
                {configIndex() === 2 ? "\u25b6" : " "} Capital
              </text>
              <text fg={theme.text}>${currentConfig().capital.toLocaleString()}</text>
            </box>
          </box>

          <text fg={theme.textMuted} marginTop={1}>
            <b>h/l</b> change <b>j/k</b> nav <b>enter</b> run
          </text>
        </box>
      </Show>

      {/* Step: Running */}
      <Show when={step() === "running"}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Running Backtest
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>

          <text fg={theme.textMuted}>
            Strategy: <span style={{ fg: theme.text }}>{selectedStrategy()?.name}</span>
          </text>
          <text fg={theme.textMuted}>Running backtest...</text>
        </box>
      </Show>

      {/* Step: Results */}
      <Show when={step() === "results" && result()}>
        {(() => {
          const res = result()!
          return (
            <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Backtest Results
                </text>
                <text fg={theme.textMuted}>esc</text>
              </box>

              <text fg={theme.textMuted}>
                {selectedStrategy()?.name} <span style={{ fg: theme.text }}>({res.symbol})</span> - {res.bars_processed} bars ({res.period}, {res.interval})
              </text>

              <box marginTop={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Starting Capital</text>
                  <text fg={theme.text}>${res.starting_capital.toLocaleString()}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Ending Equity</text>
                  <text fg={theme.text}>${res.ending_equity.toLocaleString()}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Total Return</text>
                  <text fg={res.total_return >= 0 ? theme.success : theme.error}>
                    {res.total_return >= 0 ? "+" : ""}{res.total_return.toFixed(2)}%
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Max Drawdown</text>
                  <text fg={theme.error}>-{res.max_drawdown.toFixed(2)}%</text>
                </box>
              </box>

              <box marginTop={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Total Trades</text>
                  <text fg={theme.text}>{res.total_trades}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Win / Lose</text>
                  <text fg={theme.text}>
                    <span style={{ fg: theme.success }}>{res.winning_trades}</span> / <span style={{ fg: theme.error }}>{res.losing_trades}</span>
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Win Rate</text>
                  <text fg={res.win_rate >= 50 ? theme.success : theme.error}>{res.win_rate.toFixed(1)}%</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Avg Win / Loss</text>
                  <text fg={theme.text}>
                    <span style={{ fg: theme.success }}>${res.avg_win.toFixed(2)}</span> / <span style={{ fg: theme.error }}>${Math.abs(res.avg_loss).toFixed(2)}</span>
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Profit Factor</text>
                  <text fg={res.profit_factor >= 1 ? theme.success : theme.error}>{res.profit_factor.toFixed(2)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.textMuted}>Total Fees</text>
                  <text fg={theme.textMuted}>${res.total_fees.toFixed(2)}</text>
                </box>
              </box>

              <text fg={theme.textMuted} marginTop={1}>
                <b>enter/esc</b> close
              </text>
            </box>
          )
        })()}
      </Show>
    </>
  )
}
