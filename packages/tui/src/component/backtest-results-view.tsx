import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import type { BacktestRunner } from "@/backtest/runner"

const DURATION_LABELS: Record<string, string> = {
  "1m": "1 Month",
  "3m": "3 Months",
  "6m": "6 Months",
  "1y": "1 Year",
}

/** Signed percent for returns (shows +/-) */
function fmtSignedPct(value: number): string {
  const pct = value * 100
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(2)}%`
}

/** Unsigned percent for rates/risk metrics */
function fmtPct(value: number): string {
  const pct = value * 100
  return `${pct.toFixed(2)}%`
}

function fmtUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtNum(value: number | null | undefined, decimals = 2): string {
  return value == null ? "N/A" : value.toFixed(decimals)
}

export function formatBacktestPlainMetrics(results: BacktestRunner.Results): string {
  return [
    results.productLabel ?? (results.runKind === "legacy" ? "Legacy backtest" : "Crucible 2.0"),
    `return ${fmtSignedPct(results.totalReturn)}`,
    `Sharpe ${fmtNum(results.sharpeRatio)}`,
    `max DD ${fmtPct(results.maxDrawdown)}`,
    `trades ${results.totalTrades}`,
    `win rate ${fmtPct(results.winRate)}`,
    `profit factor ${fmtNum(results.profitFactor)}`,
  ].join(", ")
}

// Fixed-width columns: label = 22 chars, value = 16 chars
const LW = 22
const VW = 16
const hline = (left: string, mid: string, right: string) =>
  `${left}${"─".repeat(LW + 2)}${mid}${"─".repeat(VW + 2)}${right}`

const TOP = hline("┌", "┬", "┐")
const MID = hline("├", "┼", "┤")
const BOT = hline("└", "┴", "┘")

/**
 * Render a label/value row as a SINGLE line string.
 *
 * Rows used to be a `flexDirection="row"` box of several sibling `<text>` cells,
 * which rendered as empty rows in the TUI (only the single-string border lines
 * showed). Building the whole line as one string — exactly like the border
 * lines that render correctly — keeps the cells aligned and visible.
 */
export function formatTableRowLine(label: string, value: string): string {
  return "│ " + label.padEnd(LW) + " │ " + value.padStart(VW) + " │"
}

/** Full-width section header line (spans both columns). */
export function formatHeaderRowLine(text: string): string {
  return "│ " + text.padEnd(LW + VW + 3) + " │"
}

type RowData = { label: string; value: string; color?: any; bold?: boolean }

export function BacktestResultsView(props: {
  algorithmName: string
  params: { duration: string; interval: string; capital: string }
  results: BacktestRunner.Results
}) {
  const { theme } = useTheme()
  const r = () => props.results
  const durationLabel = () => DURATION_LABELS[props.params.duration] ?? props.params.duration
  const capitalLabel = () => fmtUsd(parseFloat(props.params.capital))
  const productLabel = () => r().productLabel ?? (r().runKind === "legacy" ? "Legacy backtest" : "Crucible 2.0")
  const returnColor = () => (r().totalReturn >= 0 ? theme.success : theme.error)
  const sharpeColor = () =>
    r().sharpeRatio >= 1 ? theme.success : r().sharpeRatio < 0 ? theme.error : theme.text
  const winRateColor = () =>
    r().winRate >= 0.5 ? theme.success : r().winRate < 0.3 ? theme.error : theme.text

  const coreRows = (): RowData[] => [
    { label: "Total Return", value: fmtSignedPct(r().totalReturn), color: returnColor(), bold: true },
    { label: "Max Drawdown", value: fmtPct(r().maxDrawdown), color: theme.error },
    { label: "Sharpe Ratio", value: fmtNum(r().sharpeRatio), color: sharpeColor() },
    { label: "Volatility", value: fmtPct(r().annualizedVolatility) },
    { label: "Ending Equity", value: fmtUsd(r().endingEquity), color: returnColor(), bold: true },
  ]

  const crucibleRows = (): RowData[] => {
    const rows: RowData[] = []
    const nav = r().navSummary
    if (nav) {
      rows.push(
        { label: "MTM NAV", value: fmtUsd(nav.mark_to_market_nav), color: returnColor() },
        { label: "Liquidation NAV", value: fmtUsd(nav.liquidation_nav), color: returnColor() },
      )
    }
    const cost = r().costAttribution
    if (cost) {
      rows.push(
        { label: "Total Costs", value: fmtUsd(cost.total_costs) },
        { label: "Cost / Start", value: fmtPct(cost.cost_as_pct_starting_equity) },
      )
    }
    if (r().eligibilityStatus) rows.push({ label: "Eligibility", value: r().eligibilityStatus! })
    return rows
  }

  const tradeRows = (): RowData[] => [
    { label: "Total Trades", value: fmtNum(r().totalTrades, 0) },
    { label: "Win Rate", value: fmtPct(r().winRate), color: winRateColor() },
    { label: "Profit Factor", value: fmtNum(r().profitFactor) },
  ]

  const extendedRows = (): RowData[] =>
    r().sortino !== undefined && r().totalTrades > 0
      ? [
          { label: "Sortino Ratio", value: fmtNum(r().sortino ?? 0) },
          { label: "Calmar Ratio", value: fmtNum(r().calmar ?? 0) },
          { label: "VaR (95%)", value: fmtPct(r().var95 ?? 0) },
          { label: "CVaR (95%)", value: fmtPct(r().cvar95 ?? 0) },
          { label: "Max DD Duration", value: `${r().maxDdDuration ?? 0} bars` },
          { label: "Time in Market", value: fmtPct(r().timeInMarket ?? 0) },
        ]
      : []

  const hasDiagnostics = () => r().totalTrades === 0 && !!r().diagnostics
  const diag = () => r().diagnostics!

  const diagRows = (): RowData[] =>
    hasDiagnostics()
      ? [
          { label: "Bars Processed", value: fmtNum(diag().barsProcessed, 0) },
          { label: "Buy Attempts", value: fmtNum(diag().buyAttempts, 0) },
          { label: "Sell Attempts", value: fmtNum(diag().sellAttempts, 0) },
          {
            label: "Rejected Orders",
            value: fmtNum(diag().rejectedOrders, 0),
            color: diag().rejectedOrders > 0 ? theme.error : undefined,
          },
        ]
      : []

  // Single-line rows (one <text> node, like the border lines) so the cells
  // always render — a row of sibling <text> cells showed up empty in the TUI.
  const TableRow = (p: RowData) => (
    <text fg={p.color ?? theme.text} attributes={p.bold ? TextAttributes.BOLD : 0}>
      {formatTableRowLine(p.label, p.value)}
    </text>
  )

  const HeaderRow = (p: { text: string }) => (
    <text fg={theme.text} attributes={TextAttributes.BOLD}>
      {formatHeaderRowLine(p.text)}
    </text>
  )

  return (
    <box flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.algorithmName}
      </text>
      <text fg={theme.textMuted}>
        {productLabel()} · {durationLabel()} · {props.params.interval} · {capitalLabel()}
      </text>

      <box flexDirection="column" paddingTop={1}>
        <text fg={theme.textMuted}>{TOP}</text>
        <HeaderRow text="PERFORMANCE" />
        <text fg={theme.textMuted}>{MID}</text>
        <For each={coreRows()}>{(row) => <TableRow {...row} />}</For>
        <Show when={crucibleRows().length > 0}>
          <text fg={theme.textMuted}>{MID}</text>
          <HeaderRow text="CRUCIBLE 2.0" />
          <text fg={theme.textMuted}>{MID}</text>
          <For each={crucibleRows()}>{(row) => <TableRow {...row} />}</For>
        </Show>
        <text fg={theme.textMuted}>{MID}</text>
        <HeaderRow text="TRADES" />
        <text fg={theme.textMuted}>{MID}</text>
        <For each={tradeRows()}>{(row) => <TableRow {...row} />}</For>

        <Show when={extendedRows().length > 0}>
          <text fg={theme.textMuted}>{MID}</text>
          <HeaderRow text="RISK" />
          <text fg={theme.textMuted}>{MID}</text>
          <For each={extendedRows()}>{(row) => <TableRow {...row} />}</For>
        </Show>

        <Show when={hasDiagnostics()}>
          <text fg={theme.textMuted}>{MID}</text>
          <HeaderRow text="DIAGNOSTICS" />
          <text fg={theme.textMuted}>{MID}</text>
          <For each={diagRows()}>{(row) => <TableRow {...row} />}</For>
        </Show>

        <text fg={theme.textMuted}>{BOT}</text>
      </box>

      <Show when={r().explanations}>
        <box paddingTop={1} paddingLeft={1} flexDirection="column">
          <text fg={theme.textMuted}>{r().explanations!.mark_to_market_nav}</text>
          <text fg={theme.textMuted}>{r().explanations!.liquidation_nav}</text>
          <text fg={theme.textMuted}>{r().explanations!.cost_attribution}</text>
        </box>
      </Show>

      {/* Diagnostic likely-cause below table */}
      <Show when={hasDiagnostics()}>
        <box paddingTop={1} paddingLeft={1}>
          <Show when={diag().rejectedOrders > 0 && Object.keys(diag().rejectionReasons).length > 0}>
            <text fg={theme.textMuted}>
              {"Rejections: " + Object.entries(diag().rejectionReasons).map(([r, c]) => `${r} (${c})`).join(", ")}
            </text>
          </Show>
          <Show when={diag().buyAttempts === 0 && diag().strategyErrors === 0}>
            <text fg={theme.warning}>Likely cause: Entry conditions never triggered — thresholds may be too restrictive.</text>
          </Show>
          <Show when={diag().rejectedOrders > 0 && diag().rejectedOrders === diag().buyAttempts}>
            <text fg={theme.warning}>Likely cause: All buy orders were rejected.</text>
          </Show>
          <Show when={diag().strategyErrors > 0}>
            <text fg={theme.warning}>Likely cause: Strategy raised {diag().strategyErrors} exceptions.</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}
