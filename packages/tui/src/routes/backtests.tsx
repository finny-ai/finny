import { createMemo, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useBacktestHistory, type BacktestHistoryEntry } from "../context/backtest-history"
import { useDialog } from "../ui/dialog"
import { Card } from "../component/card"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { DialogBacktestResults } from "../component/dialog-backtest-results"

function formatPercent(value: number): string {
  const pct = value * 100
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(2)}%`
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

const DURATION_LABELS: Record<string, string> = {
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
}

function isCrucibleRun(entry: BacktestHistoryEntry): boolean {
  return entry.results.runKind !== "legacy"
}

export function Backtests() {
  const { theme } = useTheme()
  const route = useRoute()
  const history = useBacktestHistory()
  const dialog = useDialog()

  const runs = createMemo(() => history.list())
  const crucibleRuns = createMemo(() => runs().filter(isCrucibleRun))
  const legacyRuns = createMemo(() => runs().filter((entry) => !isCrucibleRun(entry)))

  const openRun = (entry: BacktestHistoryEntry) => {
    DialogBacktestResults.show(dialog, entry.algorithmName, entry.params, entry.results)
  }

  const clearAll = () => {
    history.clear()
  }

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.backtests as unknown as string[]}
        title="Backtests"
        subtitle="Crucible 2.0 and legacy performance analysis"
        meta={`${crucibleRuns().length} Crucible · ${legacyRuns().length} legacy`}
      />

      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        paddingBottom={2}
        flexDirection="column"
        minHeight={0}
      >
        <Card title=" Recent runs ">
          <Show
            when={runs().length > 0}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  No backtests yet
                </text>
                <text fg={theme.textMuted}>
                  Pick an algorithm and use the <span style={{ fg: theme.primary }}>▶ Run Backtest</span> button to create one.
                </text>
                <box height={1} minHeight={0} />
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={theme.primary}
                  onMouseUp={() => route.navigate({ type: "algorithms" })}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>
                    → Go to Algorithms
                  </text>
                </box>
              </box>
            }
          >
            <box flexDirection="column" flexGrow={1} minHeight={0}>
              {/* Column header */}
              <box
                flexDirection="row"
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                paddingBottom={1}
                border={["bottom"]}
                borderColor={theme.borderSubtle}
              >
                <box width={24} flexShrink={0}>
                  <text fg={theme.textMuted}>Algorithm</text>
                </box>
                <box width={12} flexShrink={0}>
                  <text fg={theme.textMuted}>Period</text>
                </box>
                <box width={14} flexShrink={0}>
                  <text fg={theme.textMuted}>Return</text>
                </box>
                <box width={14} flexShrink={0}>
                  <text fg={theme.textMuted}>Drawdown</text>
                </box>
                <box width={14} flexShrink={0}>
                  <text fg={theme.textMuted}>Ending</text>
                </box>
                <box width={10} flexShrink={0}>
                  <text fg={theme.textMuted}>Trades</text>
                </box>
                <box flexGrow={1}>
                  <text fg={theme.textMuted}>When</text>
                </box>
              </box>

              {/* Rows */}
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
                <box flexDirection="column">
                  <Show when={crucibleRuns().length > 0}>
                    <box paddingLeft={1} paddingTop={1}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>Crucible 2.0 runs</text>
                    </box>
                  </Show>
                  <For each={crucibleRuns()}>
                    {(entry) => {
                      const returnColor = () =>
                        entry.results.totalReturn >= 0 ? theme.success : theme.error
                      return (
                        <box
                          flexDirection="row"
                          paddingLeft={1}
                          paddingRight={1}
                          paddingTop={0}
                          paddingBottom={0}
                          onMouseUp={() => openRun(entry)}
                        >
                          <box width={24} flexShrink={0}>
                            <text fg={theme.text} attributes={TextAttributes.BOLD}>
                              {entry.algorithmName}
                            </text>
                          </box>
                          <box width={12} flexShrink={0}>
                            <text fg={theme.textMuted}>
                              {DURATION_LABELS[entry.params.duration] ?? entry.params.duration} · {entry.params.interval}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={returnColor()} attributes={TextAttributes.BOLD}>
                              {formatPercent(entry.results.totalReturn)}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={theme.error}>
                              {formatPercent(entry.results.maxDrawdown)}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={returnColor()}>
                              {formatCurrency(entry.results.endingEquity)}
                            </text>
                          </box>
                          <box width={10} flexShrink={0}>
                            <text fg={theme.text}>
                              {entry.results.totalTrades}
                            </text>
                          </box>
                          <box flexGrow={1}>
                            <text fg={theme.textMuted}>{formatRelative(entry.timestamp)}</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                  <Show when={legacyRuns().length > 0}>
                    <box paddingLeft={1} paddingTop={1}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>Legacy runs</text>
                    </box>
                  </Show>
                  <For each={legacyRuns()}>
                    {(entry) => {
                      const returnColor = () =>
                        entry.results.totalReturn >= 0 ? theme.success : theme.error
                      return (
                        <box
                          flexDirection="row"
                          paddingLeft={1}
                          paddingRight={1}
                          paddingTop={0}
                          paddingBottom={0}
                          onMouseUp={() => openRun(entry)}
                        >
                          <box width={24} flexShrink={0}>
                            <text fg={theme.text} attributes={TextAttributes.BOLD}>
                              {entry.algorithmName}
                            </text>
                          </box>
                          <box width={12} flexShrink={0}>
                            <text fg={theme.textMuted}>
                              {DURATION_LABELS[entry.params.duration] ?? entry.params.duration} · {entry.params.interval}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={returnColor()} attributes={TextAttributes.BOLD}>
                              {formatPercent(entry.results.totalReturn)}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={theme.error}>
                              {formatPercent(entry.results.maxDrawdown)}
                            </text>
                          </box>
                          <box width={14} flexShrink={0}>
                            <text fg={returnColor()}>
                              {formatCurrency(entry.results.endingEquity)}
                            </text>
                          </box>
                          <box width={10} flexShrink={0}>
                            <text fg={theme.text}>
                              {entry.results.totalTrades}
                            </text>
                          </box>
                          <box flexGrow={1}>
                            <text fg={theme.textMuted}>{formatRelative(entry.timestamp)}</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </scrollbox>

              {/* Footer */}
              <box flexDirection="row" flexShrink={0} paddingTop={1}>
                <box flexGrow={1}>
                  <text fg={theme.textMuted}>
                    Click a row to re-open its full metrics.
                  </text>
                </box>
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={clearAll}
                >
                  <text fg={theme.textMuted}>clear history</text>
                </box>
              </box>
            </box>
          </Show>
        </Card>
      </box>
    </box>
  )
}
