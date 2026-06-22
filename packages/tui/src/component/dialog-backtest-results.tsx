import { TextAttributes } from "@opentui/core"
import { onMount, Show } from "solid-js"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import type { BacktestRunner } from "@/backtest/runner"

export interface DialogBacktestResultsProps {
  algorithmName: string
  params: { duration: string; interval: string; capital: string }
  results: BacktestRunner.Results
}

const DURATION_LABELS: Record<string, string> = {
  "1m": "1 Month",
  "3m": "3 Months",
  "6m": "6 Months",
  "1y": "1 Year",
}

function formatPercent(value: number): string {
  const pct = value * 100
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(2)}%`
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatNumber(value: number | null | undefined, decimals = 2): string {
  return value == null ? "N/A" : value.toFixed(decimals)
}

export function DialogBacktestResults(props: DialogBacktestResultsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("medium")
  })

  const r = () => props.results
  const durationLabel = () => DURATION_LABELS[props.params.duration] ?? props.params.duration
  const capitalLabel = () => formatCurrency(parseFloat(props.params.capital))
  const productLabel = () => r().productLabel ?? (r().runKind === "legacy" ? "Legacy backtest" : "Crucible 2.0")

  const returnColor = () => (r().totalReturn >= 0 ? theme.success : theme.error)
  const drawdownColor = () => theme.error
  const sharpeColor = () => (r().sharpeRatio >= 1 ? theme.success : r().sharpeRatio < 0 ? theme.error : theme.text)
  const winRateColor = () => (r().winRate >= 0.5 ? theme.success : r().winRate < 0.3 ? theme.error : theme.text)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {productLabel()} Results — {props.algorithmName}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>
        Duration: {durationLabel()} · Interval: {props.params.interval} · Capital: {capitalLabel()}
      </text>

      <box gap={0} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Total Return</text>
          <text fg={returnColor()} attributes={TextAttributes.BOLD}>{formatPercent(r().totalReturn)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Max Drawdown</text>
          <text fg={drawdownColor()}>{formatPercent(r().maxDrawdown)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Sharpe Ratio</text>
          <text fg={sharpeColor()}>{formatNumber(r().sharpeRatio)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Volatility</text>
          <text fg={theme.text}>{formatPercent(r().annualizedVolatility)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Ending Equity</text>
          <text fg={returnColor()} attributes={TextAttributes.BOLD}>{formatCurrency(r().endingEquity)}</text>
        </box>
        <Show when={r().navSummary}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>Mark-to-market NAV</text>
            <text fg={returnColor()}>{formatCurrency(r().navSummary!.mark_to_market_nav)}</text>
          </box>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>Liquidation NAV</text>
            <text fg={returnColor()}>{formatCurrency(r().navSummary!.liquidation_nav)}</text>
          </box>
        </Show>
      </box>

      <box gap={0} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Total Trades</text>
          <text fg={theme.text}>{formatNumber(r().totalTrades, 0)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Win Rate</text>
          <text fg={winRateColor()}>{formatPercent(r().winRate)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Profit Factor</text>
          <text fg={theme.text}>{formatNumber(r().profitFactor)}</text>
        </box>
        <Show when={r().costAttribution}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>Costs</text>
            <text fg={theme.text}>{formatCurrency(r().costAttribution!.total_costs)}</text>
          </box>
        </Show>
        <Show when={r().eligibilityStatus}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>Eligibility</text>
            <text fg={theme.text}>{r().eligibilityStatus}</text>
          </box>
        </Show>
      </box>

      <Show when={r().explanations}>
        <box gap={0} paddingTop={1}>
          <text fg={theme.textMuted}>{r().explanations!.mark_to_market_nav}</text>
          <text fg={theme.textMuted}>{r().explanations!.liquidation_nav}</text>
          <text fg={theme.textMuted}>{r().explanations!.cost_attribution}</text>
          <text fg={theme.textMuted}>{r().explanations!.profile_identity}</text>
        </box>
      </Show>

      <text fg={theme.textMuted} paddingTop={1}>press esc to close</text>
    </box>
  )
}

DialogBacktestResults.show = (
  dialog: DialogContext,
  algorithmName: string,
  params: { duration: string; interval: string; capital: string },
  results: BacktestRunner.Results,
) => {
  dialog.replace(() => <DialogBacktestResults algorithmName={algorithmName} params={params} results={results} />)
}
