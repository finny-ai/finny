import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import type { BacktestRunner } from "@/backtest/runner"

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

function formatNumber(value: number, decimals = 2): string {
  return value.toFixed(decimals)
}

export function BacktestResultsView(props: {
  algorithmName: string
  params: { duration: string; interval: string; capital: string }
  results: BacktestRunner.Results
}) {
  const { theme } = useTheme()
  const r = () => props.results
  const durationLabel = () => DURATION_LABELS[props.params.duration] ?? props.params.duration
  const capitalLabel = () => formatCurrency(parseFloat(props.params.capital))
  const returnColor = () => (r().totalReturn >= 0 ? theme.success : theme.error)
  const drawdownColor = () => theme.error
  const sharpeColor = () =>
    r().sharpeRatio >= 1 ? theme.success : r().sharpeRatio < 0 ? theme.error : theme.text
  const winRateColor = () =>
    r().winRate >= 0.5 ? theme.success : r().winRate < 0.3 ? theme.error : theme.text

  const Row = (p: { label: string; value: string; color?: any; bold?: boolean }) => (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <text fg={theme.text}>{p.label}</text>
      <text fg={p.color ?? theme.text} attributes={p.bold ? TextAttributes.BOLD : 0}>
        {p.value}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.algorithmName}
      </text>
      <text fg={theme.textMuted}>
        {durationLabel()} · {props.params.interval} · {capitalLabel()}
      </text>
      <box gap={0} paddingTop={1}>
        <Row label="Total Return" value={formatPercent(r().totalReturn)} color={returnColor()} bold />
        <Row label="Max Drawdown" value={formatPercent(r().maxDrawdown)} color={drawdownColor()} />
        <Row label="Sharpe Ratio" value={formatNumber(r().sharpeRatio)} color={sharpeColor()} />
        <Row label="Volatility" value={formatPercent(r().annualizedVolatility)} />
        <Row label="Ending Equity" value={formatCurrency(r().endingEquity)} color={returnColor()} bold />
      </box>
      <box gap={0} paddingTop={1}>
        <Row label="Total Trades" value={formatNumber(r().totalTrades, 0)} />
        <Row label="Win Rate" value={formatPercent(r().winRate)} color={winRateColor()} />
        <Row label="Profit Factor" value={formatNumber(r().profitFactor)} />
      </box>
    </box>
  )
}
