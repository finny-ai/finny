import type { BacktestRunner } from "../backtest/runner"
import type { BacktestQuality } from "../backtest/evaluation"

export type FailureClassification =
  | "data_blocked"
  | "engine_failed"
  | "validation_failed"
  | "zero_trades"
  | "sizing_failure"
  | "strategy_loss"
  | "strategy_exception"
  | "concept_exhausted"

export type LikelyCauseBucket = "strategy_code" | "backtest_data" | "concept"

export interface FailureDiagnosisMetrics {
  totalReturn?: number
  sharpeRatio?: number
  maxDrawdown?: number
  totalTrades?: number
  winRate?: number
  buyAttempts?: number
  sellAttempts?: number
  rejectedOrders?: number
  rejectionReasons?: Record<string, number>
  strategyErrors?: number
  barsProcessed?: number
}

export interface FailureDiagnosis {
  classification: FailureClassification
  likelyCause: LikelyCauseBucket
  summary: string
  subreason?: string
  engineRan: boolean
  metrics?: FailureDiagnosisMetrics
  codePatternWarnings?: string[]
  guidance: string[]
}

type DiagnosticsLike = {
  buyAttempts: number
  sellAttempts: number
  rejectedOrders: number
  rejectionReasons: Record<string, number>
  strategyErrors: number
  barsProcessed?: number
}

function marginRejection(reasons: Record<string, number>): boolean {
  return Object.keys(reasons).some((r) => /margin|buying_?power|insufficient/i.test(r))
}

function orderAttempts(d: DiagnosticsLike): number {
  return d.buyAttempts + d.sellAttempts
}

function allOrdersRejected(d: DiagnosticsLike): boolean {
  return orderAttempts(d) > 0 && d.rejectedOrders >= orderAttempts(d)
}

function allOrdersRejectedForMargin(d: DiagnosticsLike): boolean {
  return allOrdersRejected(d) && marginRejection(d.rejectionReasons)
}

function codeWarningsOrUndefined(codeWarnings: string[]): string[] | undefined {
  return codeWarnings.length > 0 ? codeWarnings : undefined
}

/**
 * Diagnose WHY a zero-trade backtest produced no fills. Returns display lines
 * (without the leading blank). Kept for backward compatibility with zero-trade
 * output and tests.
 */
export function zeroTradeLikelyCause(d: DiagnosticsLike): string[] {
  const reasons = Object.keys(d.rejectionReasons)

  if (allOrdersRejectedForMargin(d)) {
    return [
      `LIKELY CAUSE: Every order (${d.buyAttempts} buys, ${d.sellAttempts} sells) was rejected for ${reasons.join(", ")}.`,
      `The order notional exceeds buying power. Check the sizing math:`,
      `  • A \`max(1, int(qty))\` clamp forces a 1-whole-unit order even when 1 unit costs more than total`,
      `    equity (e.g. 1 BTC ≈ $60K on $10K capital). Reducing the allocation/risk % does NOT fix this —`,
      `    the 1-unit minimum wins. Remove the clamp.`,
      `  • For crypto, use fractional qty: \`qty = round(equity * alloc_pct / price, 6)\`.`,
      `  • For whole-share assets, skip the trade when the computed qty floors to 0.`,
    ]
  }
  if (allOrdersRejected(d)) {
    return [`LIKELY CAUSE: All ${d.rejectedOrders} orders were rejected (${reasons.join(", ")}).`]
  }
  if (d.buyAttempts === 0 && d.strategyErrors === 0) {
    return [
      `LIKELY CAUSE: Entry conditions never triggered, OR position size too small (see above).`,
      `Check the computed qty against the asset price/stop distance — math.floor(qty) may be rounding to 0.`,
    ]
  }
  if (d.strategyErrors > 0) {
    return [`LIKELY CAUSE: Strategy raised ${d.strategyErrors} exceptions — the trading logic may be broken.`]
  }
  return []
}

export function analyzeStrategyCodePatterns(
  code: string,
  opts?: { assetClass?: string; interval?: string },
): string[] {
  const assetClass = opts?.assetClass?.toLowerCase() ?? ""
  const isCrypto = assetClass === "crypto" || /\b(BTC|ETH|SOL|DOGE|XRP)\/USD\b/i.test(code)
  const interval = opts?.interval?.toLowerCase() ?? ""
  return [
    ...(isCrypto ? cryptoSizingWarnings(code) : []),
    ...dailyTimestampWarnings(code, interval),
    ...duplicateExitWarnings(code),
  ]
}

function cryptoSizingWarnings(code: string): string[] {
  const checks: Array<[boolean, string]> = [
    [
      /\bint\s*\([^)]*\)/.test(code) && /\bqty\b/.test(code),
      "Crypto strategy contains int(qty)-style sizing — floors fractional size to 0 or distorts orders.",
    ],
    [
      /math\.floor\s*\([^)]*\)/.test(code) && /\bqty\b/.test(code),
      "Crypto strategy uses math.floor(qty) — may zero out fractional crypto sizes.",
    ],
    [/max\s*\(\s*1\s*,/.test(code), "Crypto strategy uses max(1, ...) clamp — can force 1 whole unit exceeding buying power."],
  ]
  return checks.filter(([matched]) => matched).map(([, warning]) => warning)
}

function isDailyInterval(interval: string): boolean {
  return interval === "1d" || interval === "1day"
}

function dailyTimestampWarnings(code: string, interval: string): string[] {
  const risky = isDailyInterval(interval) && /(?:\*|\+\s*)\s*1000\b|86400000|millisecond/i.test(code)
  return risky
    ? ["Daily strategy uses millisecond timestamp arithmetic — confirm bar timestamp units before relying on time-based exits."]
    : []
}

function duplicateExitWarnings(code: string): string[] {
  const exitCalls = [...code.matchAll(/\bbroker\.(?:sell|close|exit)\b/g)].map((match) => match[0])
  const duplicated = exitCalls.length >= 3 && new Set(exitCalls).size === 1
  return duplicated ? ["Multiple identical exit calls detected — check for duplicated or unreachable exit branches."] : []
}

function metricsFromResults(r: BacktestRunner.Results): FailureDiagnosisMetrics {
  const d = r.diagnostics
  return {
    totalReturn: r.totalReturn,
    sharpeRatio: r.sharpeRatio,
    maxDrawdown: r.maxDrawdown,
    totalTrades: r.totalTrades,
    winRate: r.winRate,
    buyAttempts: d?.buyAttempts,
    sellAttempts: d?.sellAttempts,
    rejectedOrders: d?.rejectedOrders,
    rejectionReasons: d?.rejectionReasons,
    strategyErrors: d?.strategyErrors,
    barsProcessed: d?.barsProcessed,
  }
}

function classifyZeroTrade(d: DiagnosticsLike, codeWarnings: string[]): FailureDiagnosis {
  const reasons = d.rejectionReasons

  if (allOrdersRejectedForMargin(d)) return sizingFailureDiagnosis(d, codeWarnings, "every order was rejected")
  if (d.strategyErrors > 0) return zeroTradeExceptionDiagnosis(d, codeWarnings)

  const subreason =
    d.buyAttempts === 0 && d.sellAttempts === 0 ? "entry_never_triggered" : "orders_rejected_or_unfilled"

  return {
    classification: "zero_trades",
    likelyCause: "strategy_code",
    subreason,
    engineRan: true,
    summary:
      subreason === "entry_never_triggered"
        ? "Backtest engine ran successfully; entry conditions never triggered and no orders were submitted."
        : "Backtest engine ran successfully; orders were attempted but no fills were recorded.",
    metrics: {
      buyAttempts: d.buyAttempts,
      sellAttempts: d.sellAttempts,
      rejectedOrders: d.rejectedOrders,
      rejectionReasons: reasons,
      strategyErrors: d.strategyErrors,
      totalTrades: 0,
    },
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: [
      "If subreason is entry_never_triggered: widen/tune entry thresholds or verify indicator warmup.",
      "If sizing warnings are present: fix qty math before changing data/provider.",
      "Do not blame the backtest engine when bars processed > 0 and diagnostics were emitted.",
    ],
  }
}

function sizingFailureDiagnosis(
  d: DiagnosticsLike,
  codeWarnings: string[],
  wording: "every order was rejected" | "orders were rejected",
): FailureDiagnosis {
  return {
    classification: "sizing_failure",
    likelyCause: "strategy_code",
    subreason: "margin_rejection",
    engineRan: true,
    summary: `Backtest engine ran successfully; ${wording} for insufficient buying power.`,
    metrics: {
      buyAttempts: d.buyAttempts,
      sellAttempts: d.sellAttempts,
      rejectedOrders: d.rejectedOrders,
      rejectionReasons: d.rejectionReasons,
      strategyErrors: d.strategyErrors,
      totalTrades: 0,
    },
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: [
      "Fix sizing implementation first — remove int(qty), math.floor(qty), and max(1, ...) clamps for crypto.",
      "Use fractional qty = round(equity * alloc_pct / price, 6) and skip when qty <= 0.",
      "Do not change provider, interval, or data window until sizing is corrected.",
    ],
  }
}

function zeroTradeExceptionDiagnosis(d: DiagnosticsLike, codeWarnings: string[]): FailureDiagnosis {
  return {
    classification: "strategy_exception",
    likelyCause: "strategy_code",
    subreason: "runtime_exceptions",
    engineRan: true,
    summary: `Backtest engine ran successfully; strategy raised ${d.strategyErrors} runtime exception(s) and produced zero trades.`,
    metrics: {
      buyAttempts: d.buyAttempts,
      sellAttempts: d.sellAttempts,
      rejectedOrders: d.rejectedOrders,
      rejectionReasons: d.rejectionReasons,
      strategyErrors: d.strategyErrors,
      totalTrades: 0,
    },
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: [
      "Fix broken state updates, indicator warmup, and broker call contracts before tuning signals.",
      "Inspect stderr/strategy error output from the backtest run.",
    ],
  }
}

function zeroTradeWithoutDiagnostics(metrics: FailureDiagnosisMetrics, codeWarnings: string[]): FailureDiagnosis {
  return {
    classification: "zero_trades",
    likelyCause: "strategy_code",
    subreason: "entry_never_triggered",
    engineRan: true,
    summary: "Backtest engine ran successfully; zero trades with no execution diagnostics.",
    metrics,
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: ["Fix entry logic and sizing before changing data/provider."],
  }
}

function strategyExceptionDiagnosis(
  d: DiagnosticsLike,
  metrics: FailureDiagnosisMetrics,
  codeWarnings: string[],
): FailureDiagnosis {
  return {
    classification: "strategy_exception",
    likelyCause: "strategy_code",
    subreason: "runtime_exceptions",
    engineRan: true,
    summary: `Backtest engine ran successfully; strategy raised ${d.strategyErrors} runtime exception(s) during the run.`,
    metrics,
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: ["Fix exceptions and state handling before retuning signal thresholds."],
  }
}

function marginFailureDiagnosis(metrics: FailureDiagnosisMetrics, codeWarnings: string[]): FailureDiagnosis {
  return {
    classification: "sizing_failure",
    likelyCause: "strategy_code",
    subreason: "margin_rejection",
    engineRan: true,
    summary: "Backtest engine ran successfully; orders were rejected for insufficient buying power.",
    metrics,
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: ["Fix sizing math and notional caps before changing signals or data."],
  }
}

function losingStrategyDiagnosis(metrics: FailureDiagnosisMetrics, codeWarnings: string[]): FailureDiagnosis {
  return {
    classification: "strategy_loss",
    likelyCause: "concept",
    subreason: "negative_performance",
    engineRan: true,
    summary: "Backtest engine ran successfully; strategy entered trades but lost money under honest assumptions.",
    metrics,
    codePatternWarnings: codeWarningsOrUndefined(codeWarnings),
    guidance: [
      "Change signal/risk logic or exits — not provider, symbol mapping, or engine settings.",
      "Report the classification; do not ask whether failure is backtest vs strategy when metrics exist.",
    ],
  }
}

function zeroTradeDiagnosis(
  d: DiagnosticsLike | undefined,
  metrics: FailureDiagnosisMetrics,
  codeWarnings: string[],
): FailureDiagnosis {
  if (!d) return zeroTradeWithoutDiagnostics(metrics, codeWarnings)
  return { ...classifyZeroTrade(d, codeWarnings), metrics: { ...metrics, totalTrades: 0 } }
}

function isProfitablePassingRun(r: BacktestRunner.Results, failedGate: boolean): boolean {
  return !failedGate && r.totalReturn > 0 && r.sharpeRatio > 0
}

function isLosingOrFailedRun(r: BacktestRunner.Results, failedGate: boolean): boolean {
  return r.totalReturn <= 0 || r.sharpeRatio <= 0 || failedGate
}

function completedRunDiagnosis(input: {
  results: BacktestRunner.Results
  failedGate: boolean
  codeWarnings: string[]
}): FailureDiagnosis | undefined {
  const { results: r, failedGate, codeWarnings } = input
  const diagnostics = r.diagnostics
  const metrics = metricsFromResults(r)
  if (r.totalTrades === 0) return zeroTradeDiagnosis(diagnostics, metrics, codeWarnings)
  if (diagnostics?.strategyErrors) return strategyExceptionDiagnosis(diagnostics, metrics, codeWarnings)
  if (diagnostics && allOrdersRejectedForMargin(diagnostics)) return marginFailureDiagnosis(metrics, codeWarnings)
  return isLosingOrFailedRun(r, failedGate) ? losingStrategyDiagnosis(metrics, codeWarnings) : undefined
}

export function classifyCompletedBacktestFailure(input: {
  results: BacktestRunner.Results
  quality: BacktestQuality
  code?: string
  assetClass?: string
  interval?: string
}): FailureDiagnosis | undefined {
  const { results: r, quality } = input
  const codeWarnings = input.code ? analyzeStrategyCodePatterns(input.code, { assetClass: input.assetClass, interval: input.interval }) : []
  const failedGate = quality.label === "failed"

  if (isProfitablePassingRun(r, failedGate)) return undefined

  return completedRunDiagnosis({ results: r, failedGate, codeWarnings })
}

export function classifyDataBlockedFailure(reason: string): FailureDiagnosis {
  return {
    classification: "data_blocked",
    likelyCause: "backtest_data",
    engineRan: false,
    summary: "Backtest did not run — strict data quality blocked execution.",
    guidance: [
      "Verify flagged candles and provider coverage before changing strategy code.",
      "No performance metrics were produced; do not call this strategy backtested.",
    ],
  }
}

export function classifyEngineFailedFailure(error: string): FailureDiagnosis {
  return {
    classification: "engine_failed",
    likelyCause: "backtest_data",
    engineRan: false,
    summary: "Backtest did not run — engine or infrastructure error before metrics were produced.",
    guidance: [
      "Inspect provider, symbol mapping, data window, and engine error text.",
      "Do not revise strategy signals until the engine produces metrics.",
    ],
  }
}

export function classifyValidationFailedFailure(): FailureDiagnosis {
  return {
    classification: "validation_failed",
    likelyCause: "strategy_code",
    engineRan: false,
    summary: "Backtest did not run — saved strategy code failed validation.",
    guidance: ["Fix validator errors/warnings at the root cause before rerunning backtest."],
  }
}

export function classifyConceptExhaustedFailure(input: {
  consecutiveFailures: number
  algorithmName: string
  priorRunsHadMetrics: boolean
}): FailureDiagnosis {
  const summary = input.priorRunsHadMetrics
    ? `Backtest engine ran successfully; ${input.consecutiveFailures} strategy variants lost money or failed quality gates for this symbol/interval.`
    : `Backtest did not run to completion ${input.consecutiveFailures} times for this symbol/interval — inspect blockers before trying more variants.`

  return {
    classification: "concept_exhausted",
    likelyCause: input.priorRunsHadMetrics ? "concept" : "backtest_data",
    engineRan: input.priorRunsHadMetrics,
    summary,
    guidance: input.priorRunsHadMetrics
      ? [
          "Summarize concept failure before trying a new strategy family.",
          "Likely cause: strategy code/design — not backtest/data when metrics were produced.",
          "Renaming the algorithm does not reset the failure budget.",
        ]
      : [
          "Likely cause: backtest/data or validation — resolve blockers before more variants.",
          "Renaming the algorithm does not reset the failure budget.",
        ],
  }
}

export function formatFailureDiagnosisBlock(d: FailureDiagnosis): string[] {
  const lines = [
    ``,
    `── FAILURE DIAGNOSIS ───────────────────────────────`,
    `Classification: ${d.classification}`,
    `Likely cause: ${d.likelyCause === "strategy_code" ? "strategy code/design" : d.likelyCause === "backtest_data" ? "backtest/data" : "concept weakness"}`,
    `Engine ran: ${d.engineRan ? "yes" : "no"}`,
    `Summary: ${d.summary}`,
  ]

  if (d.subreason) lines.push(`Subreason: ${d.subreason}`)
  lines.push(...formatDiagnosisMetrics(d.metrics))
  lines.push(...formatCodeWarnings(d.codePatternWarnings))
  lines.push(...formatGuidance(d.guidance))
  lines.push(`────────────────────────────────────────────────────`)
  return lines
}

function formatDiagnosisMetrics(m: FailureDiagnosisMetrics | undefined): string[] {
  if (!m) return []
  const lines = [
      `Metrics: return=${formatPct(m.totalReturn)} sharpe=${formatNum(m.sharpeRatio)} maxDD=${formatPct(m.maxDrawdown)} trades=${m.totalTrades ?? "N/A"} winRate=${formatPct(m.winRate)}`,
  ]
  if (m.buyAttempts != null || m.sellAttempts != null) {
    lines.push(`Orders: buyAttempts=${m.buyAttempts ?? 0} sellAttempts=${m.sellAttempts ?? 0} rejected=${m.rejectedOrders ?? 0}`)
  }
  if (m.rejectionReasons && Object.keys(m.rejectionReasons).length > 0) {
    lines.push(`Rejection reasons: ${Object.entries(m.rejectionReasons).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  }
  if (m.strategyErrors != null && m.strategyErrors > 0) lines.push(`Strategy errors: ${m.strategyErrors}`)
  return lines
}

function formatCodeWarnings(warnings: string[] | undefined): string[] {
  if (!warnings?.length) return []
  return [`Code pattern warnings:`, ...warnings.map((warning) => `  • ${warning}`)]
}

function formatGuidance(guidance: string[]): string[] {
  return guidance.length > 0 ? [`Next steps:`, ...guidance.map((item) => `  • ${item}`)] : []
}

function formatNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A"
  return v.toFixed(2)
}

function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A"
  return `${(v * 100).toFixed(2)}%`
}

export type BacktestMessageLike = {
  parts?: Array<{
    type?: string
    tool?: string
    state?: {
      status?: string
      input?: Record<string, any>
      output?: string
      metadata?: Record<string, any>
    }
  }>
}

export function priorBacktestsHadMetrics(
  messages: BacktestMessageLike[],
  scope?: { symbol?: string; interval?: string },
): boolean {
  return [...messages].reverse().some((msg) => [...(msg.parts ?? [])].reverse().some(backtestPartHasMetrics))
}

function isCompletedBacktestRun(part: NonNullable<BacktestMessageLike["parts"]>[number]): boolean {
  return part.type === "tool" && part.tool === "finny_backtest_run" && part.state?.status === "completed"
}

function backtestPartHasMetrics(part: NonNullable<BacktestMessageLike["parts"]>[number]): boolean {
  if (!isCompletedBacktestRun(part)) return false
  const state = part.state
  const metadataHasMetrics = typeof state?.metadata?.results?.totalReturn === "number"
  return metadataHasMetrics || Boolean(state?.output?.includes("BACKTEST RESULTS"))
}
