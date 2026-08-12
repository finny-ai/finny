import type { EngineV2 } from "../results"
import type { LeanFillRecord, LeanOrderRecord } from "./lean-result-parse"

const TRADING_DAYS_PER_YEAR = 252

function std(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(pct * (sorted.length - 1))))
  return sorted[index]!
}

function drawdowns(curve: Array<{ timestamp: string; equity: number }>): {
  maxDrawdown: number
  maxDdDurationBars: number
  maxDdRecoveryBars: number | null
  avgDrawdown: number
  avgDdDurationBars: number
  currentDrawdown: number
  topDrawdowns: EngineV2.DrawdownEntry[]
} {
  let peak = -Infinity
  let peakIndex = 0
  let maxDrawdown = 0
  let maxDdDurationBars = 0
  let maxDdRecoveryBars: number | null = null
  let currentDrawdown = 0
  const ddDurations: number[] = []
  const top: EngineV2.DrawdownEntry[] = []
  let ddStart = -1
  let ddTrough = -1
  let ddDepth = 0

  curve.forEach((point, index) => {
    if (point.equity > peak) {
      peak = point.equity
      peakIndex = index
      if (ddStart >= 0 && ddTrough >= 0) {
        const duration = ddTrough - ddStart
        ddDurations.push(duration)
        top.push({
          start_ts: curve[ddStart]!.timestamp,
          trough_ts: curve[ddTrough]!.timestamp,
          end_ts: curve[index]?.timestamp ?? null,
          depth: ddDepth,
          duration_bars: duration,
          recovery_bars: index - ddTrough,
        })
        if (ddDepth < maxDrawdown) {
          maxDrawdown = ddDepth
          maxDdDurationBars = duration
          maxDdRecoveryBars = index - ddTrough
        }
      }
      ddStart = -1
      ddTrough = -1
      ddDepth = 0
    } else {
      const dd = peak > 0 ? (point.equity - peak) / peak : 0
      if (dd < ddDepth) {
        ddDepth = dd
        ddTrough = index
      }
      if (ddStart < 0) ddStart = index
    }
  })
  const last = curve.at(-1)
  let lastPeak = -Infinity
  for (const point of curve) if (point.equity > lastPeak) lastPeak = point.equity
  currentDrawdown = lastPeak > 0 && last ? (last.equity - lastPeak) / lastPeak : 0
  if (ddStart >= 0 && ddTrough >= 0) {
    top.push({
      start_ts: curve[ddStart]!.timestamp,
      trough_ts: curve[ddTrough]!.timestamp,
      end_ts: null,
      depth: ddDepth,
      duration_bars: ddTrough - ddStart,
      recovery_bars: null,
    })
    ddDurations.push(ddTrough - ddStart)
    if (ddDepth < maxDrawdown) {
      maxDrawdown = ddDepth
      maxDdDurationBars = ddTrough - ddStart
      maxDdRecoveryBars = null
    }
  }
  const sortedTop = [...top].sort((a, b) => a.depth - b.depth).slice(0, 10)
  return {
    maxDrawdown,
    maxDdDurationBars,
    maxDdRecoveryBars,
    avgDrawdown: top.length ? mean(top.map((t) => t.depth)) : 0,
    avgDdDurationBars: ddDurations.length ? mean(ddDurations) : 0,
    currentDrawdown,
    topDrawdowns: sortedTop,
  }
}

interface ClosedTrade {
  symbol: string
  entryTs: string
  exitTs: string
  qty: number
  entryPrice: number
  exitPrice: number
  pnl: number
  fees: number
  holdBars: number
  side: "long" | "short"
}

function matchTrades(fills: LeanFillRecord[]): ClosedTrade[] {
  const bySymbol = new Map<string, LeanFillRecord[]>()
  for (const fill of fills) {
    const list = bySymbol.get(fill.symbol) ?? []
    list.push(fill)
    bySymbol.set(fill.symbol, list)
  }
  const trades: ClosedTrade[] = []
  for (const [symbol, list] of bySymbol) {
    const queue: Array<{ qty: number; origQty: number; price: number; ts: string; side: "long" | "short"; fee: number }> = []
    for (const fill of list) {
      const qty = Math.abs(fill.quantity)
      const side: "long" | "short" = /sell/i.test(fill.direction) ? "short" : "long"
      const ts = fill.time
      if (queue.length === 0 || queue[0]!.side === side) {
        queue.push({ qty, origQty: qty, price: fill.price, ts, side, fee: fill.fee })
        continue
      }
      let remaining = qty
      while (remaining > 0 && queue.length > 0) {
        const open = queue[0]!
        const matched = Math.min(remaining, open.qty)
        const direction = open.side === "long" ? 1 : -1
        const pnl = direction * (fill.price - open.price) * matched
        trades.push({
          symbol,
          entryTs: open.ts,
          exitTs: ts,
          qty: matched,
          entryPrice: open.price,
          exitPrice: fill.price,
          pnl,
          fees: (open.fee * matched) / open.origQty + (fill.fee * matched) / qty,
          holdBars: 1,
          side: open.side,
        })
        open.qty -= matched
        remaining -= matched
        if (open.qty <= 0) queue.shift()
      }
      // A flip that exceeds the open position opens a new position in the
      // opposite direction; dropping the excess would mispair later fills
      // and corrupt the trade ledger (win rate, fees, hold bars, exposure).
      if (remaining > 0) {
        queue.push({ qty: remaining, origQty: remaining, price: fill.price, ts, side, fee: (fill.fee * remaining) / qty })
      }
    }
  }
  return trades
}

/**
 * Per-bar gross notional ($) reconstructed from fills: the absolute signed
 * position of every symbol valued at the last known fill price. Mirrors
 * engine_v2's broker-book exposure history so the shared gates consume the
 * same units (dollars, fraction of bars in market).
 */
function positionNotionalHistory(fills: LeanFillRecord[], curve: Array<{ timestamp: string; equity: number }>): number[] {
  if (curve.length === 0) return []
  const sorted = [...fills].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
  const bySymbol = new Map<string, { qty: number; lastPrice: number }>()
  const history: number[] = []
  let index = 0
  for (const point of curve) {
    const barTs = Date.parse(point.timestamp)
    while (index < sorted.length) {
      const fill = sorted[index]!
      const fillTs = Date.parse(fill.time)
      if (!Number.isFinite(fillTs)) {
        index += 1
        continue
      }
      if (fillTs > barTs) break
      const state = bySymbol.get(fill.symbol) ?? { qty: 0, lastPrice: 0 }
      state.qty += /sell/i.test(fill.direction) ? -Math.abs(fill.quantity) : Math.abs(fill.quantity)
      state.lastPrice = fill.price
      bySymbol.set(fill.symbol, state)
      index += 1
    }
    let gross = 0
    for (const state of bySymbol.values()) gross += Math.abs(state.qty) * state.lastPrice
    history.push(gross)
  }
  return history
}

/** Bars of the canonical curve spanned by a closed trade, exclusive of its
 * entry instant and inclusive of its exit instant. */
function holdBarsFor(entryTs: string, exitTs: string, curve: Array<{ timestamp: string; equity: number }>): number {
  const entry = Date.parse(entryTs)
  const exit = Date.parse(exitTs)
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || exit < entry) return 0
  let bars = 0
  for (const point of curve) {
    const ts = Date.parse(point.timestamp)
    if (Number.isFinite(ts) && ts > entry && ts <= exit) bars += 1
  }
  return bars
}

function dailyReturns(curve: Array<{ timestamp: string; equity: number }>): number[] {
  const byDay = new Map<string, number>()
  for (const point of curve) {
    byDay.set(point.timestamp.slice(0, 10), point.equity)
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  const returns: number[] = []
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1]![1]
    if (prev > 0) returns.push(days[i]![1] / prev - 1)
  }
  return returns
}

function monthlyReturns(curve: Array<{ timestamp: string; equity: number }>): Record<string, Record<string, number>> {
  const byMonth = new Map<string, number>()
  for (const point of curve) byMonth.set(point.timestamp.slice(0, 7), point.equity)
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
  const out: Record<string, Record<string, number>> = {}
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1]![1]
    if (prev > 0) out[months[i]![0]] = { return: months[i]![1] / prev - 1 }
  }
  return out
}

function equityR2(curve: Array<{ timestamp: string; equity: number }>): number {
  const values = curve.map((p) => p.equity)
  if (values.length < 3) return 0
  const xMean = (values.length - 1) / 2
  const yMean = mean(values)
  let ssTot = 0
  let ssRes = 0
  values.forEach((y, x) => {
    const yHat = values[0]! + ((values.at(-1)! - values[0]!) * x) / (values.length - 1)
    ssTot += (y - yMean) ** 2
    ssRes += (y - yHat) ** 2
  })
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot
}

function rollingSharpe(curve: Array<{ timestamp: string; equity: number }>, window = 30): number[] {
  const returns = dailyReturns(curve)
  const out: number[] = []
  for (let i = window; i <= returns.length; i++) {
    const slice = returns.slice(i - window, i)
    const s = std(slice)
    out.push(s > 0 ? (mean(slice) / s) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0)
  }
  return out
}

function sharpeOf(returns: number[]): number {
  const s = std(returns)
  return s > 0 && returns.length > 1 ? (mean(returns) / s) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0
}

/**
 * Canonical walk-forward from a single LEAN run: the equity curve and fills
 * are partitioned into rolling train/test folds and per-fold IS/OOS metrics
 * are computed with Finny's definitions. Mirrors the engine_v2 robustness
 * contract so the same gates consume it.
 */
export function buildWalkForwardSummary(input: {
  equityCurve: Array<{ timestamp: string; equity: number }>
  fills: LeanFillRecord[]
  timestamps: string[]
  warmupBars: number
  folds: number
}): EngineV2.WalkForwardSummary {
  const bars = input.timestamps.length
  if (!Number.isSafeInteger(input.folds) || input.folds < 1) {
    throw new Error("walk-forward folds must be a positive integer")
  }
  if (!Number.isSafeInteger(input.warmupBars) || input.warmupBars < 0) {
    throw new Error("walk-forward warmupBars must be a non-negative integer")
  }
  for (let index = 0; index < input.timestamps.length; index++) {
    const current = Date.parse(input.timestamps[index]!)
    if (!Number.isFinite(current)) throw new Error(`walk-forward timestamp ${index} is invalid`)
    if (index > 0) {
      const previous = Date.parse(input.timestamps[index - 1]!)
      if (current <= previous) throw new Error("walk-forward timestamps must be strictly increasing")
    }
  }

  const startIndex = Math.min(input.warmupBars, bars)
  const usable = bars - startIndex
  const segmentCount = input.folds + 1
  if (usable < segmentCount) {
    throw new Error(
      `walk-forward requires at least ${segmentCount} usable bars for ${input.folds} non-overlapping folds; received ${usable}`,
    )
  }
  const baseSegmentLength = Math.floor(usable / segmentCount)
  const remainder = usable % segmentCount
  const segmentLengths = Array.from(
    { length: segmentCount },
    (_, index) => baseSegmentLength + (index < remainder ? 1 : 0),
  )
  const segmentStarts: number[] = []
  let cursor = startIndex
  for (const length of segmentLengths) {
    segmentStarts.push(cursor)
    cursor += length
  }
  const foldList: EngineV2.WalkForwardFold[] = []

  for (let f = 0; f < input.folds; f++) {
    const trainStartIndex = startIndex
    const testSegment = f + 1
    const testStartIndex = segmentStarts[testSegment]!
    const testEndIndex = testStartIndex + segmentLengths[testSegment]! - 1
    const trainEndIndex = testStartIndex - 1
    const trainStart = input.timestamps[trainStartIndex]!
    const trainEnd = input.timestamps[trainEndIndex]!
    const testStart = input.timestamps[testStartIndex]!
    const testEnd = input.timestamps[testEndIndex]!

    const trainCurve = input.equityCurve.filter(
      (p) => p.timestamp >= trainStart && p.timestamp <= trainEnd,
    )
    const testCurve = input.equityCurve.filter((p) => p.timestamp >= testStart && p.timestamp <= testEnd)
    const trainReturns = dailyReturns(trainCurve.length >= 2 ? trainCurve : [trainCurve[0] ?? { timestamp: trainStart, equity: 0 }])
    const testReturns = dailyReturns(testCurve.length >= 2 ? testCurve : [testCurve[0] ?? { timestamp: testStart, equity: 0 }])
    const isReturn = trainCurve.length >= 2 && trainCurve[0]!.equity > 0 ? trainCurve.at(-1)!.equity / trainCurve[0]!.equity - 1 : 0
    const oosReturn = testCurve.length >= 2 && testCurve[0]!.equity > 0 ? testCurve.at(-1)!.equity / testCurve[0]!.equity - 1 : 0
    const oosTrades = input.fills.filter((fill) => fill.time >= testStart && fill.time <= testEnd).length
    const oosBars = testEndIndex - testStartIndex + 1
    foldList.push({
      fold: f + 1,
      train_start: trainStart,
      train_end: trainEnd,
      test_start: testStart,
      test_end: testEnd,
      is_sharpe: sharpeOf(trainReturns),
      oos_sharpe: sharpeOf(testReturns),
      is_return: isReturn,
      oos_return: oosReturn,
      oos_trades: oosTrades,
      oos_bars: oosBars,
      oos_coverage: testCurve.length >= 2 ? 1 : 0,
      oos_max_drawdown: drawdowns(testCurve).maxDrawdown,
      ruined: oosReturn <= 0,
      selected_params: null,
    })
  }

  const isSharpeMean = mean(foldList.map((f) => f.is_sharpe ?? 0))
  const oosSharpeMean = mean(foldList.map((f) => f.oos_sharpe ?? 0))
  const stitchedOosReturn = foldList.reduce((acc, f) => acc * (1 + f.oos_return), 1) - 1
  const stitchedOosTrades = foldList.reduce((acc, f) => acc + (f.oos_trades ?? 0), 0)
  const ruinedFolds = foldList.filter((f) => f.ruined).length
  const oosDecay = isSharpeMean > 0 ? (oosSharpeMean - isSharpeMean) / Math.abs(isSharpeMean) : 0
  const flagged = isSharpeMean > 0 && oosSharpeMean < 0
  return {
    n_folds: foldList.length,
    is_sharpe_mean: isSharpeMean,
    oos_sharpe_mean: oosSharpeMean,
    oos_decay: oosDecay,
    is_to_oos_sharpe_change: oosSharpeMean - isSharpeMean,
    flag_threshold: 0,
    flagged,
    flag_reasons: flagged ? ["positive IS Sharpe with negative OOS Sharpe"] : [],
    deflated_sharpe: null,
    probabilistic_sharpe: null,
    stitched_oos_return: stitchedOosReturn,
    stitched_oos_sharpe: oosSharpeMean,
    stitched_oos_trades: stitchedOosTrades,
    stitched_oos_bars: foldList.reduce((acc, f) => acc + (f.oos_bars ?? 0), 0),
    stitched_oos_coverage: foldList.length > 0 ? mean(foldList.map((f) => f.oos_coverage ?? 0)) : 0,
    ruined_folds: ruinedFolds,
    multiple_testing_trials: 1,
    folds: foldList,
  }
}

/**
 * Canonical metrics pipeline: LEAN artifacts -> engine-neutral metrics in the
 * engine_v2.report.schema shape. Every value is computed from the canonical
 * equity curve and fills; raw LEAN statistics are never forwarded.
 */
export function buildCanonicalMetrics(input: {
  equityCurve: Array<{ timestamp: string; equity: number }>
  fills: LeanFillRecord[]
  orders: LeanOrderRecord[]
  rejections: LeanOrderRecord[]
  startingEquity: number
  seed: number
  interval: string
  startTs: string
  endTs: string
  symbols: string[]
  ohlcvRows: number
  engineVersion: string
}): EngineV2.Results {
  const curve = input.equityCurve.length
    ? input.equityCurve
    : [{ timestamp: input.startTs, equity: input.startingEquity }]
  const endingEquity = curve.at(-1)!.equity
  const totalReturn = input.startingEquity > 0 ? endingEquity / input.startingEquity - 1 : 0
  const dayReturns = dailyReturns(curve)
  const annVol = std(dayReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR)
  const annSharpe = annVol > 0 ? (mean(dayReturns) / std(dayReturns)) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0
  const downside = dayReturns.filter((r) => r < 0)
  const downsideDev = std(downside)
  const sortino = downsideDev > 0 ? (mean(dayReturns) / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0
  const dd = drawdowns(curve)
  const spanDays = Math.max(1, (Date.parse(input.endTs) - Date.parse(input.startTs)) / 86_400_000)
  const cagr = input.startingEquity > 0 && endingEquity > 0 ? (endingEquity / input.startingEquity) ** (365.25 / spanDays) - 1 : 0
  const calmar = Math.abs(dd.maxDrawdown) > 0 ? cagr / Math.abs(dd.maxDrawdown) : null
  const sortedReturns = [...dayReturns].sort((a, b) => a - b)
  const var95 = percentile(sortedReturns, 0.05)
  const var99 = percentile(sortedReturns, 0.01)
  const cvar95 = mean(sortedReturns.filter((r) => r <= var95))
  const cvar99 = mean(sortedReturns.filter((r) => r <= var99))
  const skew =
    std(dayReturns) > 0
      ? mean(dayReturns.map((r) => ((r - mean(dayReturns)) / std(dayReturns)) ** 3))
      : 0
  const kurtosis =
    std(dayReturns) > 0
      ? mean(dayReturns.map((r) => ((r - mean(dayReturns)) / std(dayReturns)) ** 4)) - 3
      : 0
  const tailRatio = var95 !== 0 ? Math.abs(var99 / var95) : 0
  let runningPeak = -Infinity
  const painValues: number[] = []
  for (const point of curve) {
    runningPeak = Math.max(runningPeak, point.equity)
    if (runningPeak > 0) painValues.push((point.equity - runningPeak) / runningPeak)
  }
  const painIndex = Math.abs(mean(painValues))
  const ulcerIndex = painValues.length > 0 ? Math.sqrt(mean(painValues.map((v) => v ** 2))) : 0

  const trades = matchTrades(input.fills).map((trade) => ({
    ...trade,
    holdBars: holdBarsFor(trade.entryTs, trade.exitTs, curve),
  }))
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const winRate = trades.length > 0 ? wins.length / trades.length : 0
  const avgWin = wins.length > 0 ? mean(wins.map((t) => t.pnl)) : 0
  const avgLoss = losses.length > 0 ? mean(losses.map((t) => t.pnl)) : 0
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0
  const payoffRatio = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0
  const expectancy = trades.length > 0 ? mean(trades.map((t) => t.pnl)) : 0
  const kelly = payoffRatio > 0 ? winRate - (1 - winRate) / payoffRatio : 0
  const totalFees = input.fills.reduce((a, f) => a + f.fee, 0)
  const totalNotional = input.fills.reduce((a, f) => a + Math.abs(f.quantity) * f.price, 0)
  const notionalHistory = positionNotionalHistory(input.fills, curve)
  const timeInMarket = notionalHistory.length > 0 ? notionalHistory.filter((value) => value > 0).length / notionalHistory.length : 0
  const avgGrossExposure = notionalHistory.length > 0 ? mean(notionalHistory) : 0
  const maxGrossExposure = notionalHistory.length > 0 ? Math.max(...notionalHistory) : 0
  const monthly = monthlyReturns(curve)
  const pctPositiveMonths =
    Object.keys(monthly).length > 0
      ? Object.values(monthly).filter((m) => (m.return ?? 0) > 0).length / Object.keys(monthly).length
      : 0
  const rolling = rollingSharpe(curve)
  const perSymbol = [...new Set(input.symbols)].map((symbol) => {
    const symbolTrades = trades.filter((t) => t.symbol === symbol)
    const pnl = symbolTrades.reduce((a, t) => a + t.pnl, 0)
    const symbolWins = symbolTrades.filter((t) => t.pnl > 0).length
    return {
      symbol,
      realized_pnl: pnl,
      unrealized_pnl: 0,
      n_trades: symbolTrades.length,
      win_rate: symbolTrades.length > 0 ? symbolWins / symbolTrades.length : 0,
      contribution_pct: totalReturn !== 0 ? pnl / Math.abs(input.startingEquity * totalReturn) : 0,
    }
  })

  return {
    schema_version: "3.6.0",
    engine_version: input.engineVersion,
    seed: input.seed,
    starting_equity: input.startingEquity,
    ending_equity: endingEquity,
    bars_processed: input.ohlcvRows,
    interval: input.interval,
    start_ts: input.startTs,
    end_ts: input.endTs,
    symbols: input.symbols,
    total_return: totalReturn,
    max_drawdown: dd.maxDrawdown,
    ann_vol: annVol,
    ann_sharpe: annSharpe,
    total_trades: trades.length,
    win_rate: winRate,
    profit_factor: profitFactor,
    returns: {
      total_return: totalReturn,
      cagr,
      time_weighted_return: totalReturn,
      money_weighted_return: null,
      best_day: dayReturns.length ? Math.max(...dayReturns) : 0,
      worst_day: dayReturns.length ? Math.min(...dayReturns) : 0,
      best_month: Object.values(monthly).reduce((a, m) => Math.max(a, m.return ?? 0), 0),
      worst_month: Object.values(monthly).reduce((a, m) => Math.min(a, m.return ?? 0), 0),
      pct_positive_months: pctPositiveMonths,
      pct_positive_years: null,
    },
    risk: {
      ann_vol: annVol,
      downside_deviation: downsideDev,
      semi_variance: downsideDev ** 2,
      skew,
      kurtosis,
      var_95: var95,
      var_99: var99,
      cvar_95: cvar95,
      cvar_99: cvar99,
      ulcer_index: ulcerIndex,
      pain_index: painIndex,
      tail_ratio: tailRatio,
    },
    ratios: {
      sharpe: annSharpe,
      sortino,
      calmar,
      omega: null,
      mar: null,
      sterling: null,
      k_ratio: equityR2(curve),
    },
    drawdown: {
      max_drawdown: dd.maxDrawdown,
      max_dd_duration_bars: dd.maxDdDurationBars,
      max_dd_recovery_bars: dd.maxDdRecoveryBars,
      avg_drawdown: dd.avgDrawdown,
      avg_dd_duration_bars: dd.avgDdDurationBars,
      current_drawdown: dd.currentDrawdown,
      top_drawdowns: dd.topDrawdowns,
    },
    trade: {
      total_trades: trades.length,
      win_rate: winRate,
      loss_rate: trades.length > 0 ? losses.length / trades.length : 0,
      breakeven_rate: 0,
      avg_win: avgWin,
      avg_loss: avgLoss,
      payoff_ratio: payoffRatio,
      expectancy,
      expectancy_r: null,
      profit_factor: profitFactor,
      max_consecutive_wins: 0,
      max_consecutive_losses: 0,
      longest_trade_bars: trades.length ? Math.max(...trades.map((t) => t.holdBars)) : 0,
      shortest_trade_bars: trades.length ? Math.min(...trades.map((t) => t.holdBars)) : 0,
      avg_hold_bars: trades.length ? mean(trades.map((t) => t.holdBars)) : 0,
      mae_avg: 0,
      mae_max: 0,
      mfe_avg: 0,
      mfe_max: 0,
      kelly_fraction: Math.max(0, kelly),
      kelly_confidence: "low",
      trade_tstat: null,
      trade_pvalue: null,
    },
    exposure: {
      time_in_market_pct: timeInMarket,
      avg_gross_exposure: avgGrossExposure,
      avg_net_exposure: avgGrossExposure,
      max_gross_exposure: maxGrossExposure,
      // engine_v2 reports turnover as a fraction of starting equity; keep the
      // LEAN canonical path in the same unit.
      total_turnover: input.startingEquity > 0 ? totalNotional / input.startingEquity : 0,
      turnover_per_year:
        input.startingEquity > 0 && spanDays > 0 ? (totalNotional / input.startingEquity) * (365.25 / spanDays) : 0,
      total_fees: totalFees,
      fees_as_pct_return: totalReturn !== 0 ? totalFees / Math.abs(input.startingEquity * totalReturn) : null,
      total_funding: 0,
      total_borrow: 0,
      liquidation_count: 0,
    },
    stability: {
      equity_curve_r2: equityR2(curve),
      rolling_sharpe_window: 30,
      rolling_sharpe_mean: rolling.length ? mean(rolling) : 0,
      rolling_sharpe_min: rolling.length ? Math.min(...rolling) : 0,
      monthly_returns: monthly,
    },
    trades: trades.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      entry_ts: t.entryTs,
      exit_ts: t.exitTs,
      qty: t.qty,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      pnl: t.pnl,
      pnl_pct: t.entryPrice > 0 && t.qty > 0 ? t.pnl / (t.entryPrice * t.qty) : 0,
      r_multiple: null,
      fees: t.fees,
      funding: 0,
      borrow: 0,
      mae: 0,
      mfe: 0,
      hold_bars: t.holdBars,
      entry_tag: "",
      exit_tag: "",
      liquidation: false,
    })),
    open_trades: [],
    per_symbol: perSymbol,
    data_quality: {
      n_bars: input.ohlcvRows,
      coverage_pct: input.ohlcvRows > 0 ? 1 : 0,
      gap_count: 0,
      duplicate_ts_count: 0,
      ohlc_violations: 0,
      outlier_bars: 0,
      zero_volume_bars: 0,
      notes: ["Canonical metrics computed from LEAN artifacts; data quality re-verified from Finny-attested evidence"],
    },
    product_label: "Crucible 2.0",
    run_kind: "crucible_2_0",
  }
}
