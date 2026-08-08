import type { ExperimentPlanV2, PlanSymbolBindingV2 } from "../experiment-plan"
import type {
  LeanExecutionProfileV1,
  LeanImageIdentityV1,
  LeanRuntimeBundleV1,
  RuntimeProfileV1,
  StrategySourceV1,
} from "./contracts"

/** Canonical per-symbol schedule used by the LEAN data materializer. */
export interface LeanBarScheduleV1 {
  symbol: string
  assetClass: "equity" | "crypto_spot"
  interval: string
  calendarId: string
  calendarVersion: string
  timezone: string
  bars: Array<{
    timestamp: string
    sessionId: string
  }>
  scheduleHash: string
}

/** Deterministic per-phase data bundle mounted into a LEAN run container. */
export interface LeanDataBundleV1 {
  schema: "finny.lean_data_bundle"
  version: 1
  phase: "warmup" | "exploratory" | "validation" | "confirmatory"
  interval: string
  assetFamily: "equity" | "crypto_spot"
  calendars: Array<{
    calendarId: string
    calendarVersion: string
    timezone: string
    scheduleHash: string
    start: string
    end: string
  }>
  symbols: Array<{
    canonicalSymbol: string
    leanSymbol: string
    market: string
    resolution: "Minute" | "Hour" | "Daily"
    datasetEvidenceId: string
    datasetHash: string
    scheduleHash: string
    rows: number
  }>
  fillForward: false
  normalizationMode: "raw"
  bundleHash: string
}

/** Worker contract returned by a LEAN execution. */
export interface LeanRunArtifactsV1 {
  schema: "finny.lean_run_artifacts"
  version: 1
  orders: Array<Record<string, unknown>>
  fills: Array<Record<string, unknown>>
  rejections: Array<Record<string, unknown>>
  equityCurve: Array<{ timestamp: string; equity: number }>
  rawStatistics: Record<string, unknown>
  leanResultPath: string
  leanSummaryPath: string
}

export interface LeanAdapterContextV1 {
  plan: ExperimentPlanV2
  bundle: LeanRuntimeBundleV1
  dataBundle: LeanDataBundleV1
  phase: LeanDataBundleV1["phase"]
  window: { start: string; end: string }
  seed: number
  resultsDir: string
  scratchDir: string
}

export interface LeanAdapterOutcomeV1 {
  ok: true
  artifacts: LeanRunArtifactsV1
  container: {
    imageDigest: string
    leanCommit: string
    startedAt: string
    completedAt: string
    exitCode: number
  }
}

export interface LeanAdapterFailureV1 {
  ok: false
  kind:
    | "docker_unavailable"
    | "image_unavailable"
    | "image_digest_mismatch"
    | "data_bundle_invalid"
    | "schedule_divergence"
    | "model_policy_violation"
    | "unsupported_order"
    | "engine_crash"
    | "results_unparseable"
    | "resource_breach"
    | "timeout"
    | "canceled"
    | "internal"
  error: string
  details?: Record<string, unknown>
}

export type LeanAdapterResultV1 = LeanAdapterOutcomeV1 | LeanAdapterFailureV1

/** Canonical engine-neutral backtest result consumed by qualification gates. */
export interface CrucibleResultV1 {
  schema: "finny.crucible_result"
  version: 1
  runtimeProfileId: RuntimeProfileV1["profileId"]
  startingEquity: number
  endingEquity: number
  totalReturn: number
  maxDrawdown: number
  annualizedVolatility: number
  sharpeRatio: number
  totalTrades: number
  winRate: number
  profitFactor: number | null
  fees: number
  slippage: number
  exposure: number
  navCurve: Array<{ timestamp: string; equity: number }>
  orders: Array<Record<string, unknown>>
  fills: Array<Record<string, unknown>>
  rejections: Array<Record<string, unknown>>
  diagnostics: {
    barsProcessed: number
    rejectedOrders: number
    pendingOrdersAtEnd: number
    strategyErrors: number
  }
  engineVersion: string
  runKind: "crucible_2_0"
}

export interface LeanReadyStateV1 {
  dockerAvailable: boolean
  platformSupported: boolean
  imageVerified: boolean
  adapterCertificate: boolean
  ready: boolean
  reasons: string[]
}

export type {
  ExperimentPlanV2,
  LeanExecutionProfileV1,
  LeanImageIdentityV1,
  LeanRuntimeBundleV1,
  PlanSymbolBindingV2,
  RuntimeProfileV1,
  StrategySourceV1,
}
