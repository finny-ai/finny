import fs from "fs/promises"
import os from "os"
import path from "path"
import crypto from "crypto"
import { fileURLToPath } from "url"
import { Process } from "@/util/process"
import type { Algorithm } from "@/algorithm"
import { Validate } from "@/algorithm/validate"
import { FINNY_BROKER_PY } from "./broker-py"
import { ensurePythonEnv } from "@/python/env"
import { resolveSessionPythonEnv, SESSION_PREFLIGHT_PACKAGES } from "@/python/session-env"
import { resolveSymbol } from "@/data/symbols"
import { EngineV2 } from "./results"
import { emit } from "@/analytics/emit"
import { resolveAssetSpec } from "./asset-spec"
import { BrokerRegistry } from "@/live/brokers"
import { evaluateBacktestQuality } from "./evaluation"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { BacktestStore } from "./store"
import { isVerifiedDatasetRef, type VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import {
  normalizeInterval as normalizeRequestInterval,
  normalizeSymbol as normalizeRequestSymbol,
} from "@/agent/request-identity"
import { composeBacktestVerdict, deriveWalkForwardVerdict } from "./verdict"
import * as RunIntegrity from "./run-integrity"

declare const OPENCODE_ENGINE_V2_FILES: Record<string, string> | undefined

export namespace BacktestRunner {
  export type BacktestDataSource =
    | { kind: "verified_artifact"; dataset: VerifiedDatasetRef }
    | { kind: "provider_fetch" }

  export interface Params {
    algorithm: Algorithm.Info
    duration: string // "1w" | "1m" | "3m" | "6m" | "1y"
    interval: string // "1min" | "5min" | "15min" | "30min" | "1h" | "4h" | "1d"
    capital: string // "1000" | "5000" | "10000" | "50000" | "100000"
    // When set, overrides the duration-derived window. ISO YYYY-MM-DD.
    // Used by walk-forward backtests to run two adjacent windows on the same algo.
    startDate?: string
    endDate?: string
    // Patches merged into config.json before running. Top-level keys are
    // shallow-replaced unless both old and new values are plain objects, in
    // which case they're shallow-merged (so e.g. configOverrides.params replaces
    // the whole params object, while configOverrides.risk merges with existing).
    // Used by sweep to vary strategy params per combo.
    configOverrides?: Record<string, unknown>
    // Optional deterministic seed plumbed to the Python child via FINNY_SEED.
    // When omitted, derived from a stable hash of (algorithmId, duration,
    // interval, dates) so identical runs are reproducible by default.
    seed?: number
    engineMode?: "strict_v2" | "legacy_unsafe"
    dataQualityMode?: "strict" | "repair_outliers"
    source?: BacktestStore.Source
    robustness?: {
      monteCarloPaths?: number
      regimes?: boolean
      walkForwardFolds?: number
      parameterGrid?: Record<string, Array<number | string | boolean>> | Array<Record<string, number | string | boolean>>
      /** Unique metric-producing selections completed before this run. */
      priorSelectionTrials?: number
      /** New grid selections in this run; zero for an exact deterministic replay. */
      currentSelectionTrials?: number
    }
    sessionID?: string
    /**
     * Product/session strict runs must use the exact verified data_extractor
     * artifact. Provider fetch remains available only to non-session internal
     * callers and explicitly enabled legacy migration paths.
     */
    dataSource?: BacktestDataSource
  }

  export interface Assumptions {
    fee_rate?: number
    slippage?: number
    fill_model: string
    participation_cap_pct: number
    maker_fee_bps?: number
    taker_fee_bps?: number
    slippage_bps?: number
    slippage_k_atr?: number
    slippage_k_vol?: number
    spread_enabled?: boolean
    max_leverage?: number
    maintenance_margin_pct?: number
  }

  export interface KillSwitch {
    reason: string
    equity?: number
    threshold?: number
    drawdown_frac?: number
  }

  export interface Diagnostics {
    barsProcessed: number
    buyAttempts: number
    sellAttempts: number
    rejectedOrders: number
    pendingOrdersAtEnd?: number
    rejectionReasons: Record<string, number>
    priceFirst: number
    priceLast: number
    priceRangePct: number
    strategyErrors: number
    assumptions?: Assumptions
    killed?: KillSwitch | null
    participationWarningCount?: number
    parseWarnings?: string[]
    sharpeUndefinedReason?: string
  }

  export interface Results {
    totalReturn: number
    maxDrawdown: number
    annualizedVolatility: number
    sharpeRatio: number
    endingEquity: number
    totalTrades: number
    closedTrades?: number
    openTradeCount?: number
    realizedPnl?: number
    unrealizedPnl?: number
    realizedReturn?: number
    unrealizedReturn?: number
    winRate: number
    profitFactor: number | null
    sortino?: number
    calmar?: number
    var95?: number
    var99?: number
    cvar95?: number
    cvar99?: number
    ulcerIndex?: number
    painIndex?: number
    tailRatio?: number
    skew?: number
    kurtosis?: number
    liquidationCount?: number
    maxGrossExposure?: number
    maxDdDuration?: number
    timeInMarket?: number
    diagnostics?: Diagnostics
    /** Engine identifier so consumers can label which fill model produced this run. */
    engineVersion?: string
    /** finny-core Backtest persistence schema version this run targets (2 legacy, 3 next-open). */
    schemaVersion?: number
    /** Immutable local run artifact id, present for strict_v2 runs. */
    runId?: string
    /** Absolute path to immutable local run artifacts, present for strict_v2 runs. */
    artifactDir?: string
    /** Absolute path to the user-facing local evidence bundle under Global.Path.data/backtests. */
    evidenceDir?: string
    /** Evidence persistence failure surfaced while keeping the completed simulation result. */
    evidenceError?: string
    benchmarkReturn?: number
    benchmarkMaxDrawdown?: number
    benchmarkEndingEquity?: number
    benchmarkSharpeRatio?: number | null
    alpha?: number
    /** Deployment gate state derived from validation and backtest diagnostics. */
    eligibilityStatus?: "prototype" | "validated" | "backtested" | "robustness_passed" | "paper_eligible" | "live_eligible"
    productLabel?: string
    runKind?: "crucible_2_0" | "legacy"
    navSummary?: EngineV2.NavSummary | null
    costAttribution?: EngineV2.CostAttributionSummary | null
    profileIdentity?: EngineV2.ProfileIdentity | null
    sensitivityOutcomes?: EngineV2.SensitivityOutcome[]
    explanations?: EngineV2.ResultExplanations | null
    /**
     * Full engine_v2 result blob. Present when the run completed via the v2
     * engine (the default). Carries all the new metric blocks, trades, MC,
     * walk-forward, regimes, etc. Consumers that want depth should read this
     * instead of the legacy flat fields above.
     */
    v2?: EngineV2.Results
  }

  async function materializeBundledEngineV2(destination: string): Promise<boolean> {
    if (typeof OPENCODE_ENGINE_V2_FILES === "undefined") return false
    const entries = Object.entries(OPENCODE_ENGINE_V2_FILES)
    if (entries.length === 0) return false

    await fs.rm(destination, { recursive: true, force: true })
    for (const [relative, source] of entries) {
      const normalized = relative.replaceAll("\\", "/")
      if (normalized.startsWith("../") || path.isAbsolute(normalized)) {
        throw new Error(`invalid bundled engine_v2 path: ${relative}`)
      }
      const file = path.join(destination, normalized)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, source, "utf8")
    }
    return true
  }

  /** Stable error codes surfaced from {@link run}. UI/telemetry can branch on these. */
  export type ErrorKind =
    | "unknown_symbol"
    | "empty_window"
    | "network"
    | "auth"
    | "python_env"
    | "data_evidence"
    | "config_invalid"
    | "validation_failed"
    | "unsafe_custom_runner"
    | "invalid_input"
    | "engine_invariant"
    | "results_unparseable"
    | "internal"

  export type RunResult =
    | { ok: true; results: Results }
    | { ok: false; error: string; kind: ErrorKind; suggestions?: string[] }

  export class UnknownSymbolError extends Error {
    readonly input: string
    readonly suggestions: string[]
    constructor(input: string, suggestions: string[]) {
      super(
        `Unknown symbol "${input}".` +
          (suggestions.length ? ` Try one of: ${suggestions.join(", ")}.` : ""),
      )
      this.name = "UnknownSymbolError"
      this.input = input
      this.suggestions = suggestions
    }
  }

  /**
   * Top-8 first-class suggestions to surface when a symbol can't be resolved
   * at all. The full curated list is much longer now (50+) but listing all of
   * them in an error message is just noise. Resolution is permissive — any
   * plausible ticker passes — so this only fires on true garbage like
   * empty strings or non-ASCII junk.
   */
  const SUPPORTED_CANONICAL = ["BTC/USD", "ETH/USD", "SOL/USD", "AAPL", "NVDA", "TSLA", "SPY", "QQQ"]

  const DURATION_MONTHS: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "1y": 12,
  }

  const INTERVAL_MAP: Record<string, string> = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  }

  const PRODUCT_ALLOW_LEGACY_ENV = "FINNY_ALLOW_LEGACY_BACKTEST"

  async function alpacaDataEnv(): Promise<Record<string, string>> {
    const accounts = await BrokerRegistry.listAccounts("alpaca")
    if (accounts.length === 0) return {}
    const creds = await BrokerRegistry.readCredentials(accounts[0]!.providerID)
    if (!creds) return {}
    return {
      ALPACA_API_KEY_ID: creds.keyId,
      ALPACA_API_SECRET_KEY: creds.secret,
      ALPACA_DATA_FEED: process.env.ALPACA_DATA_FEED || "iex",
    }
  }

  // Parse a duration token of the form `<int><unit>` where unit is one of
  // d / w / m / y. Returns the number of calendar days the window represents
  // (used for free-tier gating). Returns null on unparseable input.
  export function parseDurationDays(duration: string): number | null {
    const m = /^(\d+)([dwmy])$/.exec(duration.trim().toLowerCase())
    if (!m) return null
    const n = parseInt(m[1], 10)
    if (!Number.isFinite(n) || n <= 0) return null
    switch (m[2]) {
      case "d": return n
      case "w": return n * 7
      case "m": return n * 30
      case "y": return n * 365
    }
    return null
  }

  function computeDateRange(duration: string): { start: string; end: string } {
    const now = new Date()
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const start = new Date(end)
    const m = /^(\d+)([dwmy])$/.exec(duration.trim().toLowerCase())
    if (m) {
      const n = parseInt(m[1], 10)
      switch (m[2]) {
        case "d": start.setUTCDate(start.getUTCDate() - n); break
        case "w": start.setUTCDate(start.getUTCDate() - n * 7); break
        case "m": start.setUTCMonth(start.getUTCMonth() - n); break
        case "y": start.setUTCFullYear(start.getUTCFullYear() - n); break
      }
    } else {
      // Legacy fallback for any pre-existing tokens not matching <int><unit>.
      const months = DURATION_MONTHS[duration] ?? 3
      start.setUTCMonth(start.getUTCMonth() - months)
    }
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }
  }

  function makeFetchDataScript(
    symbol: string,
    assetClass: string,
    start: string,
    end: string,
    interval: string,
    csvPath: string,
  ): string {
    // Sentinels parsed by classifyFetchError() — keep prefix and field order stable.
    return `
import sys

sys.path.insert(0, ".")

try:
    from engine_v2.data.providers.alpaca import AlpacaProvider
    from engine_v2.data.providers.binance import BinanceProvider
    from engine_v2.data.providers.synthetic_options import SyntheticOptionsProvider
    from engine_v2.data.providers.yfinance import YFinanceProvider
    from engine_v2.data.quality import completed_window_exclusive_end
    import pandas as pd
except Exception as e:
    print(f"__FINNY_FETCH_ERROR__: python_env: provider import failed: {e}", file=sys.stderr)
    sys.exit(2)

symbol = ${JSON.stringify(symbol)}
asset_class = ${JSON.stringify(assetClass)}
start = ${JSON.stringify(start)}
end = ${JSON.stringify(end)}
interval = ${JSON.stringify(interval)}

# Providers treat "end" as a timestamp bound, so the bare end DATE would drop
# the end day's own bars (midnight = start of day) and strict mode would then
# block on the missing final session. Fetch through end-of-day instead, capped
# at the last completed session/bar so in-progress bars stay out. The 1-second
# shave keeps providers with inclusive end bounds from returning the bar that
# opens exactly at the boundary.
fetch_end = (completed_window_exclusive_end(end, interval, asset_class) - pd.Timedelta(seconds=1)).isoformat()

if asset_class == "equity":
    providers = [AlpacaProvider(), YFinanceProvider()]
elif asset_class == "option":
    providers = [AlpacaProvider(), SyntheticOptionsProvider()]
elif asset_class in ("crypto_spot", "crypto_perp"):
    providers = [BinanceProvider(), YFinanceProvider()]
else:
    providers = [YFinanceProvider()]

df = None
provider_used = "unknown"
errors = []
for provider in providers:
    try:
        if not provider.supports_interval(interval):
            errors.append(f"{provider.name}: unsupported interval {interval}")
            continue
        candidate = provider.fetch(symbol, start, fetch_end, interval)
        if candidate is not None and not candidate.empty:
            df = candidate
            provider_used = provider.name
            print(f"Downloaded {len(candidate)} rows from {provider.name}")
            break
        errors.append(f"{provider.name}: empty result")
    except Exception as e:
        errors.append(f"{provider.name}: {e}")

if df is None or df.empty:
    print(f"__FINNY_FETCH_ERROR__: empty_window: {symbol}: no bars between {start} and {end} at {interval}. Tried: {'; '.join(errors)}", file=sys.stderr)
    sys.exit(5)

df = df.reset_index()
# Normalize column names for the backtest harness
rename = {}
for col in df.columns:
    lc = col.strip().lower()
    if lc in ("date", "datetime"):
        rename[col] = "timestamp"
    elif lc == "open":
        rename[col] = "open"
    elif lc == "high":
        rename[col] = "high"
    elif lc == "low":
        rename[col] = "low"
    elif lc == "close":
        rename[col] = "close"
    elif lc == "volume":
        rename[col] = "volume"

df = df.rename(columns=rename)

# Ensure timestamp column exists
if "timestamp" not in df.columns:
    # Use the first column as timestamp (yfinance index)
    df = df.rename(columns={df.columns[0]: "timestamp"})

required = {"timestamp", "open", "high", "low", "close", "volume"}
missing = required - set(df.columns)
if missing:
    print(f"ERROR: Missing columns: {missing}", file=sys.stderr)
    sys.exit(1)

df[["timestamp", "open", "high", "low", "close", "volume"]].to_csv("${csvPath}", index=False)
with open("_data_provider.txt", "w") as f:
    f.write(provider_used)
`
  }

  const VERIFIED_MANIFEST_ARTIFACT = "data_extractor.manifest.json"
  const RAW_OHLCV_ARTIFACT = "ohlcv.csv"

  type BacktestDataProvenance =
    | {
        mode: "verified_artifact"
        extractor_run_id: string
        raw_manifest: {
          sha256: string
          bytes: number
          artifact: typeof VERIFIED_MANIFEST_ARTIFACT
        }
        raw_csv: {
          sha256: string
          bytes: number
          artifact: typeof RAW_OHLCV_ARTIFACT
        }
        identity: {
          schema_version?: number
          source?: string
          requested_algorithm_name: string
          requested_symbol: string
          actual_symbol: string
          requested_interval: string
          actual_interval: string
          requested_asset_class: string
          actual_asset_class: string
          requested_start: string
          requested_end: string
          actual_start: string
          actual_end: string
          rows?: number
        }
      }
    | { mode: "provider_fetch"; provider?: string; fixture_sha256?: string }

  interface PreparedBacktestData {
    providerUsed: string
    provenance: BacktestDataProvenance
  }

  class BacktestDataPreparationError extends Error {
    constructor(
      message: string,
      readonly kind: ErrorKind,
      readonly suggestions?: string[],
    ) {
      super(message)
      this.name = "BacktestDataPreparationError"
    }
  }

  function sha256Bytes(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex")
  }

  function expectedSha256(value: string, label: string): string {
    const normalized = value.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error(`verified ${label} reference has an invalid SHA-256`)
    }
    return normalized
  }

  async function rehashAndCopyExact(input: {
    source: string
    destination: string
    expected: string
    label: "manifest" | "CSV"
  }): Promise<number> {
    const expected = expectedSha256(input.expected, input.label)
    const bytes = await fs.readFile(input.source)
    const actual = sha256Bytes(bytes)
    if (actual !== expected) {
      throw new Error(`verified data ${input.label} SHA-256 mismatch (expected ${expected}, got ${actual})`)
    }
    // Write the same bytes that were hashed. Do not hash and then copy by path:
    // that would leave a TOCTOU window where the source could change in between.
    await fs.writeFile(input.destination, bytes)
    return bytes.byteLength
  }

  function assertManifestIdentityMatchesRef(dataset: VerifiedDatasetRef, manifest: Record<string, unknown>): void {
    const identity = dataset.identity
    const fields: Array<[string, unknown, unknown]> = [
      ["schema_version", manifest.schema_version, identity.schemaVersion],
      ["source", manifest.source, identity.source],
      ["run_id", manifest.run_id, identity.runId],
      ["requested_algorithm_name", manifest.requested_algorithm_name, identity.requestedAlgorithmName],
      ["requested_symbol", manifest.requested_symbol, identity.requestedSymbol],
      ["actual_symbol", manifest.actual_symbol, identity.actualSymbol],
      ["requested_interval", manifest.requested_interval, identity.requestedInterval],
      ["actual_interval", manifest.actual_interval, identity.actualInterval],
      ["requested_asset_class", manifest.requested_asset_class, identity.requestedAssetClass],
      ["actual_asset_class", manifest.actual_asset_class, identity.actualAssetClass],
      ["requested_start", manifest.requested_start, identity.requestedStart],
      ["requested_end", manifest.requested_end, identity.requestedEnd],
      ["actual_start", manifest.actual_start, identity.actualStart],
      ["actual_end", manifest.actual_end, identity.actualEnd],
      ["rows", manifest.rows, identity.rows],
    ]
    const mismatch = fields.find(([, manifestValue, refValue]) => manifestValue !== refValue)
    if (mismatch) {
      const [field, manifestValue, refValue] = mismatch
      throw new Error(
        `verified data reference identity mismatch for ${field} ` +
          `(manifest=${String(manifestValue)}, reference=${String(refValue)})`,
      )
    }
  }

  async function prepareBacktestData(input: {
    dataSource: BacktestDataSource
    tmpDir: string
    fetchProvider?: () => Promise<PreparedBacktestData>
  }): Promise<PreparedBacktestData> {
    if (input.dataSource.kind === "provider_fetch") {
      if (!input.fetchProvider) throw new Error("provider fetch callback is required")
      return input.fetchProvider()
    }

    const dataset = input.dataSource.dataset
    if (!isVerifiedDatasetRef(dataset)) {
      throw new Error("verified data reference was not issued by the data_extractor evidence gate")
    }
    const manifestSize = await rehashAndCopyExact({
      source: dataset.manifestPath,
      destination: path.join(input.tmpDir, VERIFIED_MANIFEST_ARTIFACT),
      expected: dataset.manifestSha256,
      label: "manifest",
    })
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(await fs.readFile(path.join(input.tmpDir, VERIFIED_MANIFEST_ARTIFACT), "utf8")) as Record<
        string,
        unknown
      >
    } catch (error: any) {
      throw new Error(`verified data manifest is not valid JSON: ${error?.message ?? String(error)}`)
    }
    assertManifestIdentityMatchesRef(dataset, manifest)
    const csvSize = await rehashAndCopyExact({
      source: dataset.csvPath,
      destination: path.join(input.tmpDir, RAW_OHLCV_ARTIFACT),
      expected: dataset.csvSha256,
      label: "CSV",
    })
    const identity = dataset.identity
    return {
      providerUsed: identity.source ?? "verified_data_extractor",
      provenance: {
        mode: "verified_artifact",
        extractor_run_id: identity.runId,
        raw_manifest: {
          sha256: dataset.manifestSha256.toLowerCase(),
          bytes: manifestSize,
          artifact: VERIFIED_MANIFEST_ARTIFACT,
        },
        raw_csv: {
          sha256: dataset.csvSha256.toLowerCase(),
          bytes: csvSize,
          artifact: RAW_OHLCV_ARTIFACT,
        },
        identity: {
          schema_version: identity.schemaVersion,
          source: identity.source,
          requested_algorithm_name: identity.requestedAlgorithmName,
          requested_symbol: identity.requestedSymbol,
          actual_symbol: identity.actualSymbol,
          requested_interval: identity.requestedInterval,
          actual_interval: identity.actualInterval,
          requested_asset_class: identity.requestedAssetClass,
          actual_asset_class: identity.actualAssetClass,
          requested_start: identity.requestedStart,
          requested_end: identity.requestedEnd,
          actual_start: identity.actualStart,
          actual_end: identity.actualEnd,
          rows: identity.rows,
        },
      },
    }
  }

  function dataPreparationFailure(error: unknown, dataSource: BacktestDataSource): Extract<RunResult, { ok: false }> {
    if (error instanceof BacktestDataPreparationError) {
      return { ok: false, error: error.message, kind: error.kind, suggestions: error.suggestions }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error:
        dataSource.kind === "verified_artifact"
          ? `Verified data artifact could not be staged: ${detail}`
          : `Backtest data preparation failed: ${detail}`,
      kind: dataSource.kind === "verified_artifact" ? "data_evidence" : "internal",
    }
  }

  function attachDataSourceProvenance(results: Results, provenance: BacktestDataProvenance): void {
    if (!results.v2) return
    results.v2.run_metadata = {
      ...(results.v2.run_metadata ?? {}),
      data_source_mode: provenance.mode,
      raw_data_provenance: provenance,
    }
  }

  function normalizedEvidenceAssetClass(value: string): string {
    const normalized = value.trim().toLowerCase()
    if (["crypto", "cryptocurrency", "crypto_spot"].includes(normalized)) return "crypto_spot"
    if (["equity", "equities", "stock", "stocks"].includes(normalized)) return "equity"
    return normalized
  }

  function verifiedDatasetIdentityIssue(input: {
    dataset: VerifiedDatasetRef
    symbol: string
    interval: string
    assetClass: string
  }): string | undefined {
    const identity = input.dataset.identity
    const expectedSymbol = normalizeRequestSymbol(input.symbol)
    const actualSymbol = normalizeRequestSymbol(identity.actualSymbol)
    if (actualSymbol !== expectedSymbol) {
      return `verified data symbol mismatch (artifact=${identity.actualSymbol}, backtest=${input.symbol})`
    }

    const expectedInterval = normalizeRequestInterval(input.interval) ?? input.interval.trim().toLowerCase()
    const actualInterval =
      normalizeRequestInterval(identity.actualInterval) ?? identity.actualInterval.trim().toLowerCase()
    if (actualInterval !== expectedInterval) {
      return `verified data interval mismatch (artifact=${identity.actualInterval}, backtest=${input.interval})`
    }

    const expectedAssetClass = normalizedEvidenceAssetClass(input.assetClass)
    const actualAssetClass = normalizedEvidenceAssetClass(identity.actualAssetClass)
    if (actualAssetClass !== expectedAssetClass) {
      return `verified data asset class mismatch (artifact=${identity.actualAssetClass}, backtest=${input.assetClass})`
    }
    return undefined
  }

  /**
   * Test-only entry point for parseResults. Exposed so unit tests can verify
   * the line-format parser handles nan/inf, assumptions, kill switch, etc.
   * without spinning up Python. Pass an empty tmpDir to skip the JSON path.
   */
  export const _internalForTests = {
    parseResults: (stdout: string, tmpDir: string) => parseResults(stdout, tmpDir),
    calendarBarsPerYear,
    computeBuyHoldBenchmark,
    prepareBacktestData,
    attachDataSourceProvenance,
    hasProductRiskContract,
    ENGINE_VERSION: "", // populated below once ENGINE_VERSION is in scope
  } as {
    parseResults: typeof parseResults
    calendarBarsPerYear: typeof calendarBarsPerYear
    computeBuyHoldBenchmark: typeof computeBuyHoldBenchmark
    prepareBacktestData: typeof prepareBacktestData
    attachDataSourceProvenance: typeof attachDataSourceProvenance
    hasProductRiskContract: typeof hasProductRiskContract
    ENGINE_VERSION: string
  }

  function assumptionsFromV2(v2: EngineV2.Results): Assumptions {
    const cfg = (v2 as any).execution_config ?? {}
    return {
      fill_model: cfg.fill_model ?? "engine_v2.next_open",
      participation_cap_pct: Number(cfg.participation_pct ?? 0.10) * 100,
      maker_fee_bps: cfg.maker_fee_bps,
      taker_fee_bps: cfg.taker_fee_bps,
      slippage_bps: cfg.slippage_bps,
      slippage_k_atr: cfg.k_atr,
      slippage_k_vol: cfg.k_vol,
      spread_enabled: cfg.spread_enabled,
      max_leverage: cfg.max_leverage,
      maintenance_margin_pct: cfg.maintenance_margin_pct,
    }
  }

  function resultsFromV2(v2: EngineV2.Results): Results {
    const realizedPnl = (v2.trades ?? []).reduce((sum, trade) => sum + (Number.isFinite(trade.pnl) ? trade.pnl : 0), 0)
    const unrealizedPnl = (v2.open_trades ?? []).reduce(
      (sum, trade) => sum + (Number.isFinite(trade.unrealized_pnl) ? trade.unrealized_pnl : 0),
      0,
    )
    const startingEquity = Number.isFinite(v2.starting_equity) && v2.starting_equity > 0 ? v2.starting_equity : undefined
    return {
      totalReturn: v2.total_return,
      maxDrawdown: Math.abs(v2.max_drawdown),
      annualizedVolatility: v2.ann_vol,
      sharpeRatio: v2.ann_sharpe,
      endingEquity: v2.ending_equity,
      totalTrades: v2.total_trades,
      closedTrades: v2.total_trades,
      openTradeCount: v2.open_trades?.length ?? 0,
      realizedPnl,
      unrealizedPnl,
      realizedReturn: startingEquity ? realizedPnl / startingEquity : undefined,
      unrealizedReturn: startingEquity ? unrealizedPnl / startingEquity : undefined,
      winRate: v2.win_rate,
      profitFactor: v2.profit_factor ?? null,
      sortino: v2.ratios?.sortino,
      calmar: v2.ratios?.calmar ?? undefined,
      var95: v2.risk?.var_95,
      var99: v2.risk?.var_99,
      cvar95: v2.risk?.cvar_95,
      cvar99: v2.risk?.cvar_99,
      ulcerIndex: v2.risk?.ulcer_index,
      painIndex: v2.risk?.pain_index,
      tailRatio: v2.risk?.tail_ratio,
      skew: v2.risk?.skew,
      kurtosis: v2.risk?.kurtosis,
      liquidationCount: v2.exposure?.liquidation_count,
      maxGrossExposure: v2.exposure?.max_gross_exposure,
      maxDdDuration: v2.drawdown?.max_dd_duration_bars,
      timeInMarket: v2.exposure?.time_in_market_pct,
      diagnostics: {
        barsProcessed: v2.bars_processed,
        buyAttempts: Number((v2.diagnostics as any)?.buy_attempts ?? 0),
        sellAttempts: Number((v2.diagnostics as any)?.sell_attempts ?? 0),
        rejectedOrders: Number((v2.diagnostics as any)?.rejected_orders ?? 0),
        pendingOrdersAtEnd: Number((v2.diagnostics as any)?.pending_orders_at_end ?? 0),
        rejectionReasons: ((v2.diagnostics as any)?.rejection_reasons ?? {}) as Record<string, number>,
        priceFirst: 0,
        priceLast: 0,
        priceRangePct: 0,
        strategyErrors: 0,
        assumptions: assumptionsFromV2(v2),
      },
      engineVersion: v2.engine_version,
      schemaVersion: parseInt((v2.schema_version || "0").split(".")[0], 10),
      productLabel: v2.product_label ?? "Crucible 2.0",
      runKind: v2.run_kind ?? "crucible_2_0",
      navSummary: v2.nav_summary ?? null,
      costAttribution: v2.cost_attribution ?? null,
      profileIdentity: v2.profile_identity ?? null,
      sensitivityOutcomes: v2.sensitivity_outcomes ?? [],
      explanations: v2.explanations ?? null,
      v2,
    }
  }

  /**
   * Parse engine_v2 results.json (preferred — emits the full result blob)
   * with a fallback to the legacy line-format stdout. The line format stays
   * supported so any external strategy that ships its own backtest.py keeps
   * working without modification.
   */
  async function parseResults(stdout: string, tmpDir: string, allowLineFallback = true): Promise<Results | null> {
    const jsonPath = path.join(tmpDir, "results.json")
    try {
      const raw = await fs.readFile(jsonPath, "utf8")
      const v2 = JSON.parse(raw) as EngineV2.Results
      const major = parseInt((v2.schema_version || "0").split(".")[0], 10)
      if (major === EngineV2.SCHEMA_VERSION_MAJOR) {
        return resultsFromV2(v2)
      }
      // Schema major mismatch — fall through to line parse; emit a marker so
      // telemetry can see this happened.
      console.warn(`[backtest] results.json schema ${v2.schema_version} not v${EngineV2.SCHEMA_VERSION_MAJOR}; falling back to line parse`)
    } catch {
      // No JSON — strategy probably ran via a legacy embedded backtest.py
    }

    if (!allowLineFallback) return null

    const lines = stdout.split("\n")
    const metrics: Record<string, number> = {}
    const parseWarnings: string[] = []
    const strings: Record<string, string> = {}
    // Numeric value: optional sign, then digits/exponent/dot, OR nan/inf tokens.
    const numericRe = /^([\w_]+):\s*(-?(?:nan|inf|\d[\d.eE+\-]*))\s*$/i
    // String value: anything else (engine_version, JSON blobs, etc.)
    const stringRe = /^([\w_]+):\s+(.+)$/
    for (const line of lines) {
      const numMatch = line.match(numericRe)
      if (numMatch) {
        const key = numMatch[1]
        const tok = numMatch[2].toLowerCase()
        if (tok === "nan" || tok === "inf" || tok === "-inf") {
          parseWarnings.push(`${key}=${tok}`)
          metrics[key] = key === "profit_factor"
            ? null as any
            : (tok === "nan" ? Number.NaN : (tok === "inf" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY))
          continue
        }
        const val = parseFloat(numMatch[2])
        if (Number.isFinite(val)) {
          metrics[key] = val
        } else {
          parseWarnings.push(`${key}=${numMatch[2]} (unparseable)`)
        }
        continue
      }
      const strMatch = line.match(stringRe)
      if (strMatch) strings[strMatch[1]] = strMatch[2].trim()
    }
    if (!("ending_equity" in metrics) && strings["ending_equity"] === undefined) return null

    const diagBars = metrics["diag_bars_processed"]
    let diagnostics: Diagnostics | undefined
    if (diagBars !== undefined) {
      let rejectionReasons: Record<string, number> = {}
      try { if (strings["diag_rejection_reasons"]) rejectionReasons = JSON.parse(strings["diag_rejection_reasons"]) } catch {}
      let assumptions: Assumptions | undefined
      try { if (strings["diag_assumptions"]) assumptions = JSON.parse(strings["diag_assumptions"]) as Assumptions } catch {}
      let killed: KillSwitch | undefined
      try { if (strings["diag_killed"]) killed = JSON.parse(strings["diag_killed"]) as KillSwitch } catch {}
      diagnostics = {
        barsProcessed: diagBars,
        buyAttempts: metrics["diag_buy_attempts"] ?? 0,
        sellAttempts: metrics["diag_sell_attempts"] ?? 0,
        rejectedOrders: metrics["diag_rejected_orders"] ?? 0,
        pendingOrdersAtEnd: metrics["diag_pending_orders_at_end"],
        rejectionReasons,
        priceFirst: metrics["diag_price_first"] ?? 0,
        priceLast: metrics["diag_price_last"] ?? 0,
        priceRangePct: metrics["diag_price_range_pct"] ?? 0,
        strategyErrors: metrics["diag_strategy_errors"] ?? 0,
        assumptions,
        killed: killed ?? null,
        participationWarningCount: metrics["diag_participation_warning_count"],
        parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
        sharpeUndefinedReason: strings["diag_sharpe_undefined_reason"] || undefined,
      }
    } else if (parseWarnings.length > 0) {
      // No diag block but we did see nan/inf — surface a minimal diagnostics
      // payload so the parse_warnings aren't dropped.
      diagnostics = {
        barsProcessed: 0, buyAttempts: 0, sellAttempts: 0, rejectedOrders: 0,
        rejectionReasons: {}, priceFirst: 0, priceLast: 0, priceRangePct: 0,
        strategyErrors: 0, parseWarnings,
      }
    }

    const schemaVersion = metrics["backtest_schema_version"]

    // Synthesize a minimal v2 blob ONLY if the legacy shim emitted stability
    // or regime JSON. Keeps payloads lean for old runs while making the new
    // populated fields visible to anything that reads results.v2.
    let v2: EngineV2.Results | undefined
    let stabilityParsed: EngineV2.StabilityMetrics | undefined
    let regimesParsed: EngineV2.RegimeBreakdown[] | undefined
    try { if (strings["stability_json"]) stabilityParsed = JSON.parse(strings["stability_json"]) } catch {}
    try { if (strings["regimes_json"]) regimesParsed = JSON.parse(strings["regimes_json"]) } catch {}
    if (stabilityParsed || regimesParsed) {
      v2 = {
        // Mirror the legacy flat values so downstream consumers don't NPE on
        // missing fields; only stability/regimes carry new information.
        schema_version: String(EngineV2.SCHEMA_VERSION_MAJOR) + ".0",
        engine_version: strings["engine_version"] || "engine.next-open-v1",
        seed: 0,
        starting_equity: 0,
        ending_equity: metrics["ending_equity"] ?? 0,
        bars_processed: metrics["diag_bars_processed"] ?? 0,
        interval: "",
        start_ts: "",
        end_ts: "",
        symbols: [],
        total_return: metrics["total_return"] ?? 0,
        max_drawdown: metrics["max_drawdown"] ?? 0,
        ann_vol: metrics["ann_vol"] ?? 0,
        ann_sharpe: metrics["ann_sharpe"] ?? 0,
        total_trades: metrics["total_trades"] ?? 0,
        win_rate: metrics["win_rate"] ?? 0,
        profit_factor: metrics["profit_factor"] ?? null,
        returns: undefined as any,
        risk: undefined as any,
        ratios: undefined as any,
        drawdown: undefined as any,
        trade: undefined as any,
        exposure: undefined as any,
        stability: stabilityParsed as any,
        trades: [],
        per_symbol: [],
        data_quality: undefined as any,
        regimes: regimesParsed ?? null,
      } as EngineV2.Results
    }

    return {
      totalReturn: metrics["total_return"] ?? 0,
      maxDrawdown: metrics["max_drawdown"] ?? 0,
      annualizedVolatility: metrics["ann_vol"] ?? 0,
      sharpeRatio: metrics["ann_sharpe"] ?? 0,
      endingEquity: metrics["ending_equity"] ?? 0,
      totalTrades: metrics["total_trades"] ?? 0,
      winRate: metrics["win_rate"] ?? 0,
      profitFactor: metrics["profit_factor"] ?? null,
      sortino: metrics["sortino"],
      calmar: metrics["calmar"],
      var95: metrics["var_95"],
      cvar95: metrics["cvar_95"],
      maxDdDuration: metrics["max_dd_duration"],
      timeInMarket: metrics["time_in_market"],
      diagnostics,
      engineVersion: strings["engine_version"] || undefined,
      schemaVersion: schemaVersion != null ? Math.trunc(schemaVersion) : undefined,
      productLabel: "Legacy backtest",
      runKind: "legacy",
      v2,
    }
  }

  /**
   * Default backtest.py shim used when an algorithm doesn't ship its own
   * runner. Uses finny_broker.py's SimBroker + load_strategy() to run the
   * strategy bar-by-bar. Outputs legacy key: value lines that the TS parser
   * expects. Algorithms that supply their own `backtestCode` bypass this shim.
   */
  // engine.next-open-v1 — fills happen at next bar's open (not current close),
  // equity/Sharpe/drawdown are reported raw (no clip/cap), VaR uses correct
  // percentile, and an opt-in kill switch can halt on blow-up.
  const ENGINE_VERSION = "engine.next-open-v1"
  ;(_internalForTests as any).ENGINE_VERSION = ENGINE_VERSION
  const DEFAULT_BACKTEST_PY = String.raw`#!/usr/bin/env python3
"""Default Finny backtest runner — SimBroker + dynamic strategy loader.

Execution model: next-bar-open. Each bar:
  1. settle pending orders at bar["open"] (fills carry slippage + fees);
  2. call strategy.on_bar(symbol, bar) — buy/sell calls enqueue intents;
  3. mark equity at bar["close"].

This eliminates the same-bar lookahead where strategies could decide using
the close they were about to fill at.
"""
import argparse, csv, json, math, os, random, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from finny_broker import SimBroker, ScanBroker, load_strategy

# Deterministic seed plumbed in via env so identical runs produce identical
# results. Strategies that use random / numpy.random inherit the seed.
_SEED_ENV = os.environ.get("FINNY_SEED")
if _SEED_ENV:
    try:
        _seed = int(_SEED_ENV)
        random.seed(_seed)
        try:
            import numpy as _np
            _np.random.seed(_seed & 0xFFFFFFFF)
        except ImportError:
            pass
    except (TypeError, ValueError):
        pass


def _percentile(sorted_xs, p):
    """Linear-interpolated percentile (NumPy default). 0 <= p <= 100."""
    if not sorted_xs:
        return 0.0
    if len(sorted_xs) == 1:
        return float(sorted_xs[0])
    k = (len(sorted_xs) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(sorted_xs[int(k)])
    return float(sorted_xs[int(f)] * (c - k) + sorted_xs[int(c)] * (k - f))


def _compute_stability(eq_curve, returns, bpy, bar_timestamps, window=30):
    """StabilityMetrics — rolling Sharpe summary, monthly_returns, equity-curve R^2."""
    if len(returns) < 2:
        return None
    # Rolling Sharpe: sliding-window mean/std * sqrt(bpy)
    rs = []
    if len(returns) >= window:
        for i in range(window, len(returns) + 1):
            w = returns[i - window:i]
            m = sum(w) / len(w)
            v = sum((r - m) ** 2 for r in w) / len(w)
            s = math.sqrt(v)
            if s > 0:
                rs.append(m / s * math.sqrt(bpy))
    rs_mean = sum(rs) / len(rs) if rs else 0.0
    rs_min = min(rs) if rs else 0.0
    # Equity-curve R^2 against best-fit line
    n = len(eq_curve)
    if n >= 3:
        xs = list(range(n))
        x_mean = sum(xs) / n
        y_mean = sum(eq_curve) / n
        num = sum((xs[i] - x_mean) * (eq_curve[i] - y_mean) for i in range(n))
        den_x = sum((xs[i] - x_mean) ** 2 for i in range(n))
        den_y = sum((eq_curve[i] - y_mean) ** 2 for i in range(n))
        if den_x > 0 and den_y > 0:
            r = num / math.sqrt(den_x * den_y)
            r2 = r * r
        else:
            r2 = 0.0
    else:
        r2 = 0.0
    # Monthly returns keyed YYYY-MM
    monthly = {}
    # bar_timestamps is len(eq_curve) - 1 long (returns are between bars)
    if bar_timestamps and len(bar_timestamps) >= len(returns):
        for i, r in enumerate(returns):
            ts = bar_timestamps[i + 1] if (i + 1) < len(bar_timestamps) else bar_timestamps[-1]
            key = str(ts)[:7] if ts else "?"
            year, _, month = key.partition("-")
            if not month:
                continue
            bucket = monthly.setdefault(year, {})
            # Compound returns within the month
            prev = bucket.get(month, 0.0)
            bucket[month] = (1 + prev) * (1 + r) - 1
    return {
        "equity_curve_r2": r2,
        "rolling_sharpe_window": window,
        "rolling_sharpe_mean": rs_mean,
        "rolling_sharpe_min": rs_min,
        "monthly_returns": monthly,
    }


def _compute_regimes(returns, bpy, window=30):
    """RegimeBreakdown — tag each bar by rolling vol tercile and aggregate per regime."""
    if len(returns) < window * 3:
        return None
    # Rolling volatility (std of the trailing window)
    vols = [0.0] * len(returns)
    for i in range(window, len(returns)):
        w = returns[i - window:i]
        m = sum(w) / len(w)
        v = sum((r - m) ** 2 for r in w) / len(w)
        vols[i] = math.sqrt(v)
    # Tercile cutoffs from non-zero vols
    nz = sorted(v for v in vols if v > 0)
    if len(nz) < 3:
        return None
    t1 = _percentile(nz, 33.3)
    t2 = _percentile(nz, 66.6)
    buckets = {"low_vol": [], "mid_vol": [], "high_vol": []}
    for i, v in enumerate(vols):
        if v <= 0:
            continue
        regime = "low_vol" if v <= t1 else ("mid_vol" if v <= t2 else "high_vol")
        buckets[regime].append((i, returns[i]))
    out = []
    total_bars = sum(len(b) for b in buckets.values())
    for regime, items in buckets.items():
        if not items:
            continue
        rs = [r for _, r in items]
        mean_r = sum(rs) / len(rs)
        var_r = sum((r - mean_r) ** 2 for r in rs) / len(rs)
        std_r = math.sqrt(var_r)
        sharpe = (mean_r / std_r * math.sqrt(bpy)) if std_r > 0 else 0.0
        # Contiguous-segment max DD within regime
        eq = 1.0
        peak = 1.0
        max_dd = 0.0
        for r in rs:
            eq *= (1 + r)
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak if peak > 0 else 0.0
            if dd > max_dd:
                max_dd = dd
        total_ret = eq - 1.0
        out.append({
            "regime": regime,
            "n_bars": len(items),
            "pct_of_window": (len(items) / total_bars) if total_bars > 0 else 0.0,
            "total_return": total_ret,
            "sharpe": sharpe,
            "max_drawdown": max_dd,
            "n_trades": 0,  # trade-level attribution requires per-trade timestamps
            "win_rate": (sum(1 for r in rs if r > 0) / len(rs)) if rs else 0.0,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--interval", required=True)
    ap.add_argument("--capital", type=float, required=True)
    ap.add_argument("--scan-only", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    symbol = cfg.get("symbol", "ETH/USD")
    params = cfg.get("params", {})
    risk_cfg = cfg.get("risk", {}) if isinstance(cfg.get("risk"), dict) else {}
    killswitch = risk_cfg.get("killswitch_drawdown")
    try:
        killswitch = float(killswitch) if killswitch is not None else None
        if killswitch is not None and not (0.0 < killswitch < 1.0):
            killswitch = None
    except (TypeError, ValueError):
        killswitch = None

    bars = []
    with open(args.csv, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            bars.append({
                "timestamp": row.get("timestamp") or row.get("Timestamp") or row.get("date"),
                "open": float(row.get("open") or row.get("Open", 0)),
                "high": float(row.get("high") or row.get("High", 0)),
                "low": float(row.get("low") or row.get("Low", 0)),
                "close": float(row.get("close") or row.get("Close", 0)),
                "volume": float(row.get("volume") or row.get("Volume", 0)),
                "symbol": symbol,
            })

    if not bars:
        print("ending_equity: 0", file=sys.stderr)
        sys.exit(1)

    # ── PRE-FLIGHT SIGNAL SCAN ──
    # Uses bar["open"] for the visible price (next-bar-open consistency) — a
    # scan that says "0 signals" should mean "the strategy emitted no signals
    # under decision-time-safe data," not "no signals under same-bar peeking."
    if args.scan_only:
        scan = ScanBroker(starting_cash=args.capital)
        strategy_path = Path(__file__).parent / "strategy.py"
        scan_step = load_strategy(strategy_path, scan, params=params)
        scan_strategy_errors = 0
        for bar in bars:
            scan.set_time(bar.get("timestamp"))
            scan.set_price(symbol, bar["open"])
            try:
                scan_step(symbol, bar)
            except Exception:
                scan_strategy_errors += 1
            scan.mark_to_market()
        print(f"scan_buy_signals: {scan.buy_signals}")
        print(f"scan_sell_signals: {scan.sell_signals}")
        print(f"scan_strategy_errors: {scan_strategy_errors}")
        print(f"scan_bars_total: {len(bars)}")
        return

    # ── FULL BACKTEST ──
    broker = SimBroker(starting_cash=args.capital)
    if killswitch is not None:
        broker.set_killswitch(killswitch)
    strategy_path = Path(__file__).parent / "strategy.py"
    step = load_strategy(strategy_path, broker, params=params)

    bar_count = 0
    strategy_errors = 0
    price_high = -math.inf
    price_low = math.inf
    first_price = bars[0]["open"]
    last_price = bars[-1]["close"]

    for bar in bars:
        # 1. SETTLE: fill any pending orders queued on previous bar at this
        #    bar's open. Slippage and fees applied here, not at intent time.
        broker.set_time(bar.get("timestamp"))
        broker.set_bar_volume(symbol, bar.get("volume", 0.0))
        broker.settle(symbol, bar["open"])
        bar_count += 1
        # 2. DECIDE: strategy reads bar (full OHLC available for indicator
        #    computation on PRIOR closes; broker.price() returns this bar's
        #    open). buy/sell calls go to the pending queue.
        try:
            step(symbol, bar)
        except Exception as e:
            strategy_errors += 1
            print(f"[backtest] strategy error at {bar.get('timestamp','?')}: {e}", file=sys.stderr)
        # 3. MARK: stamp end-of-bar close into broker so equity curve
        #    reflects the true mark-to-market at bar close.
        broker.set_price(symbol, bar["close"])
        broker.mark_to_market()
        px = bar["close"]
        if px > price_high:
            price_high = px
        if px < price_low:
            price_low = px

    eq_curve = broker.equity_curve
    ending = eq_curve[-1] if eq_curve else args.capital
    # NO equity floor clip — losses past starting capital flow through
    # honestly. Drawdown can exceed 100% if the strategy uses leverage.

    # ── UNITS CONTRACT ────────────────────────────────────────────────
    total_return = (ending / args.capital - 1) if args.capital > 0 else 0.0

    peak = args.capital
    max_dd = 0.0
    max_dd_duration = 0
    dd_start_bar = 0
    for i, eq in enumerate(eq_curve):
        if eq >= peak:
            peak = eq
            dd_start_bar = i
        dd = (peak - eq) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
        if dd > 0:
            dur = i - dd_start_bar
            if dur > max_dd_duration:
                max_dd_duration = dur
    # No max-DD clip — values >1.0 are legitimate signals of a blowup.

    pnls = broker.trade_pnls
    total_trades = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    win_rate = (len(wins) / total_trades) if total_trades > 0 else 0.0
    win_rate = max(0.0, min(1.0, win_rate))
    gross_profit = sum(wins) if wins else 0
    gross_loss = abs(sum(losses)) if losses else 0
    if gross_loss > 0:
        profit_factor = gross_profit / gross_loss
    elif gross_profit > 0:
        # No losses at all — profit factor is undefined (infinite). Emit "inf"
        # so the TS parser records it as parse_warning rather than fabricating
        # a finite number.
        profit_factor = float("inf")
    else:
        profit_factor = 0.0

    ann_vol = ann_sharpe = sortino = calmar = var_95 = cvar_95 = time_in_market = None
    sharpe_undefined_reason = None
    if len(eq_curve) > 1:
        returns = [(eq_curve[i] / eq_curve[i-1] - 1) for i in range(1, len(eq_curve)) if eq_curve[i-1] > 0]
        if returns:
            mean_r = sum(returns) / len(returns)
            var_r = sum((r - mean_r) ** 2 for r in returns) / len(returns)
            std_r = math.sqrt(var_r)
            interval_map = {"1min": 525600, "5min": 105120, "15min": 35040, "30min": 17520, "1h": 8760, "4h": 2190, "1d": 365}
            bpy = interval_map.get(args.interval, 8760)
            ann_vol = std_r * math.sqrt(bpy)
            if std_r > 0:
                ann_sharpe = mean_r / std_r * math.sqrt(bpy)
            else:
                sharpe_undefined_reason = "zero_volatility"
            # Sortino: downside deviation only. Leave None when no negatives
            # exist — Sortino is undefined in that case, not "infinitely good."
            neg_returns = [r for r in returns if r < 0]
            if neg_returns:
                down_var = sum(r ** 2 for r in neg_returns) / len(neg_returns)
                down_dev = math.sqrt(down_var) * math.sqrt(bpy)
                if down_dev > 0:
                    sortino = (mean_r * bpy) / down_dev
            ann_return = mean_r * bpy
            if max_dd > 0:
                calmar = ann_return / max_dd
            # VaR / CVaR (95%) — correct linear-interpolated percentile.
            sorted_returns = sorted(returns)
            var_95 = abs(_percentile(sorted_returns, 5.0))
            # CVaR = mean of returns at or below the 5th percentile.
            cvar_cutoff = _percentile(sorted_returns, 5.0)
            tail = [r for r in sorted_returns if r <= cvar_cutoff]
            cvar_95 = abs(sum(tail) / len(tail)) if tail else 0.0
            bars_in_market = sum(1 for h in broker.position_history if h != 0) if hasattr(broker, 'position_history') else 0
            time_in_market = bars_in_market / max(1, bar_count)
        else:
            sharpe_undefined_reason = "no_returns"

    # No Sharpe / Sortino / Calmar / vol caps — they distort honest evaluation.

    # Low-sample threshold scales with bar count — a 1h strat over 90d (~450 bars)
    # shouldn't need the same trade count as a 1min strat over a year (~525k bars).
    # Heuristic: flag when trades < 1% of bars, with a floor of 3 (even 3 trades
    # give you a mean and variance) and a ceiling of 30 (beyond that, more bars
    # don't demand proportionally more trades).
    _min_trades = max(3, min(30, int(bar_count * 0.01)))
    low_sample = 1 if total_trades < _min_trades else 0

    # ── Trade significance: one-sample t-statistic on trade PnLs ──
    # Answers "are these returns distinguishable from random?" regardless of count.
    # t = mean(pnls) / (std(pnls) / sqrt(n)).  The p-value is a two-tailed
    # NORMAL (z) approximation — exact for large n, slightly anti-conservative
    # for small n (true Student-t has fatter tails). Treat p near the 0.05
    # boundary with caution when total_trades is small.
    trade_tstat = None
    trade_pvalue = None
    if total_trades >= 2:
        _mean_pnl = sum(pnls) / total_trades
        _var_pnl = sum((p - _mean_pnl) ** 2 for p in pnls) / (total_trades - 1)
        _std_pnl = math.sqrt(_var_pnl) if _var_pnl > 0 else 0.0
        if _std_pnl > 0:
            trade_tstat = _mean_pnl / (_std_pnl / math.sqrt(total_trades))
            # Two-tailed p-value from the standard normal CDF (z-approximation).
            _z = abs(trade_tstat)
            # Abramowitz & Stegun 26.2.17 — max error 7.5e-8
            _p = 0.2316419
            _b1, _b2, _b3, _b4, _b5 = 0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429
            _t = 1.0 / (1.0 + _p * _z)
            _phi = (1.0 / math.sqrt(2.0 * math.pi)) * math.exp(-0.5 * _z * _z)
            _norm_cdf = 1.0 - _phi * (_b1*_t + _b2*_t**2 + _b3*_t**3 + _b4*_t**4 + _b5*_t**5)
            trade_pvalue = 2.0 * (1.0 - _norm_cdf)

    def _emit(key, val, fmt="{:.6f}"):
        # None  -> "nan" (TS parser records parse_warning rather than dropping)
        # inf   -> "inf" (same)
        if val is None:
            print(f"{key}: nan")
            return
        try:
            if math.isnan(val) or math.isinf(val):
                print(f"{key}: {'inf' if val == math.inf else ('-inf' if val == -math.inf else 'nan')}")
                return
        except TypeError:
            pass
        try:
            print(f"{key}: " + fmt.format(val))
        except (ValueError, TypeError):
            print(f"{key}: {val}")

    # ── Core metrics ──
    _emit("total_return", total_return)
    _emit("max_drawdown", max_dd)
    _emit("ann_vol", ann_vol)
    _emit("ann_sharpe", ann_sharpe)
    _emit("ending_equity", ending, "{:.2f}")
    print(f"total_trades: {total_trades}")
    _emit("win_rate", win_rate)
    _emit("profit_factor", profit_factor, "{:.4f}")
    print(f"low_sample: {low_sample}")
    print(f"min_trades_threshold: {_min_trades}")
    _emit("trade_tstat", trade_tstat, "{:.4f}")
    _emit("trade_pvalue", trade_pvalue, "{:.6f}")

    # ── Extended metrics ──
    _emit("sortino", sortino, "{:.4f}")
    _emit("calmar", calmar, "{:.4f}")
    _emit("var_95", var_95)
    _emit("cvar_95", cvar_95)
    print(f"max_dd_duration: {max_dd_duration}")
    _emit("time_in_market", time_in_market, "{:.4f}")

    # ── Diagnostics ──
    diag = broker.diagnostics()
    print(f"diag_bars_processed: {bar_count}")
    print(f"diag_buy_attempts: {diag['buy_attempts']}")
    print(f"diag_sell_attempts: {diag['sell_attempts']}")
    print(f"diag_rejected_orders: {diag['rejected_orders']}")
    print(f"diag_pending_orders_at_end: {diag['pending_orders_at_end']}")
    print(f"diag_rejection_reasons: {json.dumps(diag['rejection_reasons'])}")
    print(f"diag_price_first: {first_price:.6f}")
    print(f"diag_price_last: {last_price:.6f}")
    price_range_pct = (price_high - price_low) / first_price if first_price > 0 else 0
    print(f"diag_price_range_pct: {price_range_pct:.6f}")
    print(f"diag_strategy_errors: {strategy_errors}")
    print(f"diag_participation_warning_count: {diag['participation_warning_count']}")
    print(f"diag_assumptions: {json.dumps(diag['assumptions'])}")
    if diag.get('killed'):
        print(f"diag_killed: {json.dumps(diag['killed'])}")
    if sharpe_undefined_reason:
        print(f"diag_sharpe_undefined_reason: {sharpe_undefined_reason}")

    # ── Regime / stability blocks (populate the dormant schema fields) ──
    if len(eq_curve) > 1:
        bar_timestamps = [b.get("timestamp") for b in bars]
        try:
            returns_for_stat = [(eq_curve[i] / eq_curve[i-1] - 1) for i in range(1, len(eq_curve)) if eq_curve[i-1] > 0]
            interval_map = {"1min": 525600, "5min": 105120, "15min": 35040, "30min": 17520, "1h": 8760, "4h": 2190, "1d": 365}
            bpy_loc = interval_map.get(args.interval, 8760)
            stability = _compute_stability(eq_curve, returns_for_stat, bpy_loc, bar_timestamps)
            if stability:
                print(f"stability_json: {json.dumps(stability)}")
            regimes = _compute_regimes(returns_for_stat, bpy_loc)
            if regimes:
                print(f"regimes_json: {json.dumps(regimes)}")
        except Exception as e:
            print(f"[backtest] stability/regime compute failed: {e}", file=sys.stderr)

    try:
        equity_points = eq_curve[1:] if len(eq_curve) == len(bars) + 1 else eq_curve
        with open("equity.csv", "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["timestamp", "equity"])
            writer.writeheader()
            for idx, equity in enumerate(equity_points[:len(bars)]):
                writer.writerow({
                    "timestamp": bars[idx].get("timestamp"),
                    "equity": equity,
                })
        with open("trades.csv", "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["timestamp", "side", "qty", "price", "fee_usd", "pnl"])
            writer.writeheader()
            for trade in broker.trades:
                writer.writerow(trade)
    except Exception as e:
        print(f"[backtest] artifact write failed: {e}", file=sys.stderr)

    print("engine_version: ${ENGINE_VERSION}")
    print("backtest_schema_version: 3")

if __name__ == "__main__":
    main()
`


  // Tokens commonly seen in algo names that are NOT tickers. Anything else that
  // looks like a ticker shape (2-5 alnum chars) is treated as a candidate symbol.
  const NAME_STOPWORDS = new Set([
    // Strategy patterns
    "INTRADAY", "HYBRID", "MOMENTUM", "MEAN", "REVERSION", "BREAKOUT", "DCA", "GOLDEN",
    "CROSS", "SCALPING", "SCALP", "SWING", "TREND", "RANGE", "FOLLOW", "FOLLOWING",
    "ARBITRAGE", "ARB", "PAIRS", "STAT", "GRID", "MARTINGALE", "ANTI",
    // Indicators
    "RSI", "SMA", "EMA", "MACD", "BB", "BOLLINGER", "ATR", "STOCH", "PIVOT", "FIB",
    "FIBONACCI", "ICHIMOKU", "VWAP", "OBV", "ADX", "CCI", "WILLIAMS", "DONCHIAN",
    // Generic
    "STRATEGY", "STRAT", "ALGO", "ALGORITHM", "BOT", "TRADER", "TRADING", "QUANT",
    "SIMPLE", "ADVANCED", "BASIC", "ML", "AI", "ALPHA", "BETA", "GAMMA", "DELTA",
    "FAST", "SLOW", "SHORT", "LONG", "HIGH", "LOW", "UP", "DOWN", "DAY", "NIGHT",
    "TEST", "DEMO", "DRAFT", "PROD", "PROD", "PRO", "LITE", "PLUS", "MINI", "MAX",
    "NEW", "OLD", "CUSTOM", "FINAL", "DRAFT", "WIP", "TMP",
    // Version tokens
    "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10",
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  ])

  // Crypto base tickers that need a `/USD` quote suffix when handed to yfinance.
  const CRYPTO_BASES = new Set([
    "BTC", "ETH", "SOL", "ADA", "DOT", "LINK", "UNI", "AAVE", "MATIC", "AVAX",
    "XRP", "DOGE", "SHIB", "LTC", "BCH", "ATOM", "NEAR", "FTM", "ALGO", "XLM",
    "TRX", "ETC", "FIL", "ICP", "APT", "ARB", "OP", "INJ", "SEI", "TIA", "SUI",
    "PEPE", "WLD", "RNDR", "IMX", "FET", "GRT", "STX", "MKR", "RUNE", "LDO",
  ])

  function looksLikeTicker(token: string): boolean {
    // 1-5 alphanumeric characters, starts with a letter.
    return /^[A-Z][A-Z0-9]{0,4}$/.test(token)
  }

  /**
   * Canonicalize any user-supplied symbol shape (BTC, btc, BTC-USD, BTC/USD, BTC.USD,
   * BTCUSD, BTCUSDT) into the canonical form Finny uses internally
   * ("BTC/USD" for crypto, "AAPL" for equities). Mirrors the Python
   * {@link AlpacaBroker.normalize_symbol} so the broker (Python) and the
   * backtest data fetch (TS) can never disagree on format.
   *
   * Throws {@link UnknownSymbolError} when input cannot be coerced into any
   * plausible ticker shape — empty strings, garbage tokens, etc.
   */
  export function normalizeSymbol(input: string): string {
    const raw = (input ?? "").trim()
    if (!raw) throw new UnknownSymbolError(input ?? "", SUPPORTED_CANONICAL)

    // Registry hit (BTC, BTC-USD, BTC/USD, BTCUSD, BTCUSDT, AAPL, …).
    const supported = resolveSymbol(raw)
    if (supported) return supported.canonical

    const upper = raw.toUpperCase().replace(/\s+/g, "")

    // Pair forms with explicit separator: BASE/QUOTE, BASE-QUOTE, or BASE.QUOTE.
    const sep = upper.match(/^([A-Z][A-Z0-9]{0,5})[-/.](USD|USDT|USDC)$/)
    if (sep) return `${sep[1]}/USD`

    // Glued pair: BTCUSDT, BTCUSD, BTCUSDC.
    const glued = upper.match(/^([A-Z][A-Z0-9]{0,5})(USDT|USDC|USD)$/)
    if (glued) return `${glued[1]}/USD`

    // Bare crypto base from the wider universe (XRP, DOGE, …).
    if (CRYPTO_BASES.has(upper)) return `${upper}/USD`

    // Bare equity ticker.
    if (looksLikeTicker(upper)) return upper

    throw new UnknownSymbolError(raw, SUPPORTED_CANONICAL)
  }

  /** Stderr-sentinel parser — see makeFetchDataScript for emit contract. */
  export function classifyFetchError(stderr: string): { kind: ErrorKind; detail: string } {
    const m = stderr.match(/__FINNY_FETCH_ERROR__:\s*(\w+):\s*([\s\S]*)/)
    if (m) {
      const kind = m[1] as ErrorKind
      return { kind, detail: m[2].trim() }
    }
    const lower = stderr.toLowerCase()
    if (lower.includes("externally-managed-environment") || lower.includes("no module named")) {
      return { kind: "python_env", detail: stderr.trim() }
    }
    if (lower.includes("404") || lower.includes("delisted") || lower.includes("symbol may be delisted") || lower.includes("no data found")) {
      return { kind: "unknown_symbol", detail: stderr.trim() }
    }
    if (lower.includes("timeout") || lower.includes("connection") || lower.includes("network")) {
      return { kind: "network", detail: stderr.trim() }
    }
    return { kind: "internal", detail: stderr.trim() || "unknown error" }
  }

  function detectSymbol(algorithm: Algorithm.Info): string {
    // 1. Try the strategy code for an explicit SYMBOL = "..." or "symbol": "..."
    const code = algorithm.code || ""
    const m1 = code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
    if (m1) return safeNormalize(m1[1])
    const m2 = code.match(/["']symbol["']\s*:\s*["']([^"']+)["']/)
    if (m2) return safeNormalize(m2[1])

    // 2. Tokenize the algorithm name and pick the first ticker-shaped token that
    //    isn't a known strategy/indicator/version word. This handles any equity
    //    or crypto without needing a hardcoded list — "uco-intraday-hybrid" → UCO,
    //    "tsla-momentum-v2" → TSLA, "eth-mean-reversion" → ETH → ETH/USD, etc.
    const name = (algorithm.name || "").toUpperCase()
    for (const rawToken of name.split(/[-_\s.]+/)) {
      const token = rawToken.trim()
      if (!token) continue
      if (NAME_STOPWORDS.has(token)) continue
      if (!looksLikeTicker(token)) continue
      try {
        return normalizeSymbol(token)
      } catch {
        continue
      }
    }

    // 3. Fall back to crypto default.
    return "BTC/USD"
  }

  /**
   * Best-effort normalize: returns the canonical form when the input parses,
   * otherwise the trimmed original. Used inside detectSymbol where an
   * unrecognized declaration should still be visible to the rest of the run
   * (so the error attribution path classifies it cleanly).
   */
  function safeNormalize(input: string): string {
    try {
      return normalizeSymbol(input)
    } catch {
      return (input ?? "").trim()
    }
  }

  export function classifyAssetClass(algorithm: Algorithm.Info): "crypto" | "equity" | "unknown" {
    // Prefer an explicit symbol from the config JSON.
    let symbol: string | undefined
    if (algorithm.config) {
      try {
        const c = JSON.parse(algorithm.config)
        if (typeof c?.symbol === "string") symbol = c.symbol
      } catch {}
    }
    // Fall back to scanning the strategy code.
    if (!symbol && algorithm.code) {
      const m1 = algorithm.code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
      if (m1) symbol = m1[1]
      const m2 = algorithm.code.match(/["']symbol["']\s*:\s*["']([^"']+)["']/)
      if (!symbol && m2) symbol = m2[1]
    }
    if (!symbol) return "unknown"

    const upper = symbol.toUpperCase()
    // Explicit crypto pair markers: "/USD", "-USD", "/USDT", "-USDT", "/USDC", "-USDC".
    if (/[-/](USD|USDT|USDC)$/.test(upper)) return "crypto"
    // Bare base ticker that looks like a crypto.
    const base = upper.split(/[-/]/)[0]
    if (CRYPTO_BASES.has(base)) return "crypto"
    // Everything else — AAPL, TSLA, SPY, UCO, QQQ, etc. — is equities for now.
    return "equity"
  }

  function synthesizeConfig(algorithm: Algorithm.Info): string {
    const symbol = detectSymbol(algorithm)
    return JSON.stringify(
      {
        symbol,
        required_history_bars: 30,
        risk: { starting_equity_usd: 10000 },
        _generated: "fallback — algorithm had no config",
      },
      null,
      2,
    )
  }

  /** Stable 32-bit hash for deriving a deterministic seed from run params. */
  function hashSeed(...parts: (string | undefined)[]): number {
    let h = 2166136261 >>> 0
    for (const part of parts) {
      const s = part ?? ""
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
      }
    }
    return h >>> 0
  }

  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`
  }

  function parseCapital(capital: string): number | null {
    const n = Number(capital)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  function makeRunId(date = new Date()): string {
    const compact = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    return `${compact}-${crypto.randomBytes(8).toString("hex")}`
  }

  function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback
  }

  function nullableFinite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
  }

  function splitCsvLine(line: string): string[] {
    const cells: string[] = []
    let current = ""
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === "\"") {
        if (quoted && line[i + 1] === "\"") {
          current += "\""
          i++
        } else {
          quoted = !quoted
        }
        continue
      }
      if (ch === "," && !quoted) {
        cells.push(current)
        current = ""
        continue
      }
      current += ch
    }
    cells.push(current)
    return cells
  }

  function csvCell(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return ""
    const raw = String(value)
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw
  }

  async function readCsvObjects(file: string): Promise<Record<string, string>[]> {
    const raw = await fs.readFile(file, "utf8")
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length === 0) return []
    const headers = splitCsvLine(lines[0]!).map((h) => h.trim())
    return lines.slice(1).map((line) => {
      const cells = splitCsvLine(line)
      const row: Record<string, string> = {}
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]!] = cells[i] ?? ""
      }
      return row
    })
  }

  function rowValue(row: Record<string, string>, ...names: string[]): string | undefined {
    for (const name of names) {
      if (row[name] !== undefined) return row[name]
      const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase())
      if (found) return row[found]
    }
    return undefined
  }

  function maxDrawdownFromEquity(values: number[]): number {
    let peak = values[0] ?? 0
    let maxDrawdown = 0
    for (const value of values) {
      if (!Number.isFinite(value)) continue
      if (value > peak) peak = value
      const drawdown = peak > 0 ? (peak - value) / peak : 0
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }
    return maxDrawdown
  }

  function sharpeFromEquity(values: number[], barsPerYear: number): number | null {
    const returns: number[] = []
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]
      const next = values[i]
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) returns.push(next / prev - 1)
    }
    if (returns.length < 2) return null
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
    const std = Math.sqrt(variance)
    if (std <= 0) return null
    return (mean / std) * Math.sqrt(barsPerYear)
  }

  function normalizeIntervalToken(interval: string): string {
    const s = interval.trim().toLowerCase()
    if (s.endsWith("mins")) return s.slice(0, -4) + "m"
    if (s.endsWith("min")) return s.slice(0, -3) + "m"
    return s
  }

  function intervalMinutes(normalized: string): number | null {
    if (normalized.endsWith("m")) return Number.parseInt(normalized.slice(0, -1), 10)
    if (normalized.endsWith("h")) return Number.parseInt(normalized.slice(0, -1), 10) * 60
    return null
  }

  function intervalDaySpan(normalized: string): number {
    return normalized.endsWith("d") ? Number.parseInt(normalized.slice(0, -1), 10) : 1
  }

  function calendarSessionMinutes(calendar: string): number | null {
    switch (calendar.toUpperCase()) {
      case "US_EQUITIES":
      case "US_OPTIONS":
        return 6.5 * 60
      case "US_FUTURES":
        return 23 * 60
      default:
        return null
    }
  }

  function calendarBarsPerYear(interval: string, calendar: string): number {
    const normalized = normalizeIntervalToken(interval)
    let barsPerDay: number
    if (normalized.endsWith("m")) {
      const minutes = Number.parseInt(normalized.slice(0, -1), 10)
      barsPerDay = (24 * 60) / minutes
    } else if (normalized.endsWith("h")) {
      const hours = Number.parseInt(normalized.slice(0, -1), 10)
      barsPerDay = 24 / hours
    } else if (normalized.endsWith("d")) {
      const days = Number.parseInt(normalized.slice(0, -1), 10)
      barsPerDay = 1 / days
    } else {
      throw new Error(`Unsupported interval: ${interval}`)
    }

    const sessionMinutes = calendarSessionMinutes(calendar)
    if (sessionMinutes !== null) {
      const minutes = intervalMinutes(normalized)
      return minutes !== null
        ? (sessionMinutes / minutes) * 252
        : 252 / intervalDaySpan(normalized)
    }
    if (calendar.toUpperCase() === "FX_24_5") return barsPerDay * 260
    return barsPerDay * 365
  }

  function benchmarkAssumptions(results: Results): BacktestStore.Assumptions {
    const assumptions = results.diagnostics?.assumptions
    const feeFromRate = typeof assumptions?.fee_rate === "number" ? assumptions.fee_rate * 10_000 : undefined
    const slippageFromRate = typeof assumptions?.slippage === "number" ? assumptions.slippage * 10_000 : undefined
    return {
      feeBps: finiteNumber(assumptions?.taker_fee_bps, finiteNumber(feeFromRate, 7.5)),
      slippageBps: finiteNumber(assumptions?.slippage_bps, finiteNumber(slippageFromRate, 1)),
      fillModel: assumptions?.fill_model ?? "next_open",
    }
  }

  const PROCESSED_OHLCV_CSV = "processed_ohlcv.csv"

  interface BenchmarkEvidence {
    summary: BacktestStore.BenchmarkSummary
    rows: Array<{ timestamp: string; benchmarkEquity: number }>
  }

  async function readableCsv(...candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        return candidate
      } catch {}
    }
    return null
  }

  async function computeBuyHoldBenchmark(input: {
    ohlcvCsv: string
    capital: number
    assumptions: BacktestStore.Assumptions
    interval: string
    calendar: string
  }): Promise<BenchmarkEvidence | null> {
    const rows = await readCsvObjects(input.ohlcvCsv)
    const bars = rows
      .map((row) => {
        const open = Number(rowValue(row, "open", "Open"))
        const close = Number(rowValue(row, "close", "Close"))
        const timestamp = rowValue(row, "timestamp", "Timestamp", "date", "Date") ?? ""
        return { timestamp, open, close }
      })
      .filter((row) => Number.isFinite(row.open) && row.open > 0 && Number.isFinite(row.close))
    if (bars.length === 0 || input.capital <= 0) return null

    const feeRate = Math.max(0, input.assumptions.feeBps) / 10_000
    const slippageRate = Math.max(0, input.assumptions.slippageBps) / 10_000
    const firstFill = bars[0]!.open * (1 + slippageRate)
    const qty = input.capital / (firstFill * (1 + feeRate))
    const series = bars.map((bar) => ({
      timestamp: bar.timestamp,
      benchmarkEquity: qty * bar.close,
    }))
    const equity = series.map((row) => row.benchmarkEquity)
    const endingEquity = equity[equity.length - 1] ?? input.capital
    const barsPerYear = calendarBarsPerYear(input.interval, input.calendar)
    return {
      summary: {
        kind: "buy_and_hold",
        totalReturn: endingEquity / input.capital - 1,
        maxDrawdown: maxDrawdownFromEquity(equity),
        endingEquity,
        sharpeRatio: sharpeFromEquity(equity, barsPerYear),
      },
      rows: series,
    }
  }

  function benchmarkCalendar(config: any, algorithm: Algorithm.Info, results: Results): string {
    const v2Calendar = results.v2?.asset_spec?.calendar
    if (typeof v2Calendar === "string" && v2Calendar.trim()) return v2Calendar
    const metadataCalendar = calendarFromUnknown(results.v2?.run_metadata?.asset_spec)
    if (metadataCalendar) return metadataCalendar
    try {
      return resolveAssetSpec(config, detectSymbol(algorithm)).calendar
    } catch {
      return "24/7"
    }
  }

  function hasCalendar(value: unknown): value is { calendar: unknown } {
    return value !== null && typeof value === "object" && "calendar" in value
  }

  function calendarFromUnknown(value: unknown): string | null {
    if (!hasCalendar(value)) return null
    return typeof value.calendar === "string" && value.calendar.trim() ? value.calendar : null
  }

  async function attachBuyHoldBenchmark(input: {
    tmpDir: string
    algorithm: Algorithm.Info
    config: any
    results: Results
    capital: string
    interval: string
    assumptions: BacktestStore.Assumptions
    calendar?: string
  }): Promise<BenchmarkEvidence | null> {
    const benchmarkCsv = await readableCsv(
      path.join(input.tmpDir, PROCESSED_OHLCV_CSV),
      path.join(input.tmpDir, "ohlcv.csv"),
    )
    if (!benchmarkCsv) return null
    const parsedCapital = parseCapital(input.capital) ?? input.results.endingEquity
    const benchmark = await computeBuyHoldBenchmark({
      ohlcvCsv: benchmarkCsv,
      capital: parsedCapital,
      assumptions: input.assumptions,
      interval: input.interval,
      calendar: input.calendar ?? benchmarkCalendar(input.config, input.algorithm, input.results),
    })
    if (benchmark) {
      input.results.benchmarkReturn = benchmark.summary.totalReturn
      input.results.benchmarkMaxDrawdown = benchmark.summary.maxDrawdown
      input.results.benchmarkEndingEquity = benchmark.summary.endingEquity
      input.results.benchmarkSharpeRatio = benchmark.summary.sharpeRatio
      input.results.alpha = input.results.totalReturn - benchmark.summary.totalReturn
    }
    return benchmark
  }

  async function writeCombinedEquityCsv(input: {
    tmpDir: string
    strategyEquityCsv: string
    benchmarkRows: Array<{ timestamp: string; benchmarkEquity: number }>
  }): Promise<string | undefined> {
    let strategyRows: Array<{ timestamp: string; equity: number }> = []
    try {
      const rows = await readCsvObjects(input.strategyEquityCsv)
      strategyRows = rows
        .map((row) => {
          const equity = Number(rowValue(row, "strategy_equity", "equity", "Equity"))
          const timestamp = rowValue(row, "timestamp", "ts", "date", "Date") ?? ""
          return { timestamp, equity }
        })
        .filter((row) => Number.isFinite(row.equity))
    } catch {
      strategyRows = []
    }
    if (strategyRows.length === 0 && input.benchmarkRows.length === 0) return undefined

    const lines = ["timestamp,strategy_equity,benchmark_equity"]
    const strategyByTs = new Map<string, { timestamp: string; equity: number }>()
    const benchmarkByTs = new Map<string, { timestamp: string; benchmarkEquity: number }>()
    for (const row of strategyRows) {
      const key = timestampKey(row.timestamp)
      if (key) strategyByTs.set(key, row)
    }
    for (const row of input.benchmarkRows) {
      const key = timestampKey(row.timestamp)
      if (key) benchmarkByTs.set(key, row)
    }

    if (strategyByTs.size > 0 && benchmarkByTs.size > 0) {
      const keys = [...new Set([...strategyByTs.keys(), ...benchmarkByTs.keys()])].sort(compareTimestampKeys)
      for (const key of keys) {
        const strategy = strategyByTs.get(key)
        const benchmark = benchmarkByTs.get(key)
        const timestamp = benchmark?.timestamp || strategy?.timestamp || key
        lines.push([
          csvCell(timestamp),
          csvCell(strategy?.equity),
          csvCell(benchmark?.benchmarkEquity),
        ].join(","))
      }
    } else {
      const maxRows = Math.max(strategyRows.length, input.benchmarkRows.length)
      for (let i = 0; i < maxRows; i++) {
        const strategy = strategyRows[i]
        const benchmark = input.benchmarkRows[i]
        const timestamp = benchmark?.timestamp || strategy?.timestamp || ""
        lines.push([
          csvCell(timestamp),
          csvCell(strategy?.equity),
          csvCell(benchmark?.benchmarkEquity),
        ].join(","))
      }
    }
    const out = path.join(input.tmpDir, "finny_evidence_equity.csv")
    await fs.writeFile(out, lines.join("\n") + "\n")
    return out
  }

  function timestampKey(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return null
    const time = Date.parse(trimmed)
    return Number.isFinite(time) ? new Date(time).toISOString() : trimmed
  }

  function compareTimestampKeys(a: string, b: string): number {
    const at = Date.parse(a)
    const bt = Date.parse(b)
    if (Number.isFinite(at) && Number.isFinite(bt)) return at - bt
    return a.localeCompare(b)
  }

  interface PersistBacktestEvidenceInput {
    tmpDir: string
    runId: string
    algorithm: Algorithm.Info
    config: any
    results: Results
    duration: string
    interval: string
    capital: string
    startDate?: string
    endDate?: string
    source: BacktestStore.Source
    benchmark?: BenchmarkEvidence | null
    calendar?: string
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function persistBacktestEvidence(input: PersistBacktestEvidenceInput): Promise<void> {
    const assumptions = benchmarkAssumptions(input.results)
    const benchmark = input.benchmark === undefined
      ? await attachBuyHoldBenchmark({
          tmpDir: input.tmpDir,
          algorithm: input.algorithm,
          config: input.config,
          results: input.results,
          capital: input.capital,
          interval: input.interval,
          assumptions,
          calendar: input.calendar,
        })
      : input.benchmark
    if (benchmark) {
      input.results.benchmarkReturn = benchmark.summary.totalReturn
      input.results.benchmarkMaxDrawdown = benchmark.summary.maxDrawdown
      input.results.benchmarkEndingEquity = benchmark.summary.endingEquity
      input.results.benchmarkSharpeRatio = benchmark.summary.sharpeRatio
      input.results.alpha = input.results.totalReturn - benchmark.summary.totalReturn
    }
    const equityCsv = benchmark
      ? await writeCombinedEquityCsv({
          tmpDir: input.tmpDir,
          strategyEquityCsv: path.join(input.tmpDir, "equity.csv"),
          benchmarkRows: benchmark.rows,
        })
      : undefined

    const saved = await BacktestStore.save({
      record: {
        id: input.runId,
        source: input.source,
        algorithmId: input.algorithm.algorithmId,
        algorithmName: input.algorithm.name,
        algorithmVersion: Number((input.algorithm as any).version ?? 0) || 0,
        symbol: typeof input.config.symbol === "string" ? input.config.symbol : input.results.v2?.symbols?.[0],
        params: {
          duration: input.duration,
          interval: input.interval,
          capital: input.capital,
          startDate: input.startDate,
          endDate: input.endDate,
        },
        assumptions,
        results: {
          totalReturn: finiteNumber(input.results.totalReturn),
          maxDrawdown: finiteNumber(input.results.maxDrawdown),
          annualizedVolatility: finiteNumber(input.results.annualizedVolatility),
          sharpeRatio: finiteNumber(input.results.sharpeRatio),
          endingEquity: finiteNumber(input.results.endingEquity),
          totalTrades: finiteNumber(input.results.totalTrades),
          winRate: finiteNumber(input.results.winRate),
          profitFactor: nullableFinite(input.results.profitFactor),
          productLabel: input.results.productLabel,
          runKind: input.results.runKind,
          eligibilityStatus: input.results.eligibilityStatus,
        },
        benchmark: benchmark?.summary ?? null,
        alpha: benchmark ? input.results.totalReturn - benchmark.summary.totalReturn : null,
        timestamp: Date.now(),
        artifacts: {
          sourceArtifacts: input.results.artifactDir,
        },
      },
      artifacts: {
        equityCsv,
        tradesCsv: path.join(input.tmpDir, "trades.csv"),
        sourceArtifacts: input.results.artifactDir,
      },
    })
    input.results.evidenceDir = saved.dir
  }

  async function persistBacktestEvidenceOrReport(input: PersistBacktestEvidenceInput): Promise<void> {
    try {
      await persistBacktestEvidence(input)
    } catch (error) {
      const message = errorText(error)
      input.results.evidenceError = message
      console.warn(`[backtest] failed to persist local evidence: ${message}`)
    }
  }

  function isPlainObj(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === "object" && !Array.isArray(x)
  }

  function applyConfigOverrides(config: any, configOverrides?: Record<string, unknown>) {
    if (!configOverrides) return
    for (const [k, v] of Object.entries(configOverrides)) {
      if (k === "params") {
        config[k] = v
      } else if (isPlainObj(v) && isPlainObj(config[k])) {
        config[k] = { ...config[k], ...v }
      } else {
        config[k] = v
      }
    }
  }

  function buildArtifactAssetSpec(config: any, algorithm: Algorithm.Info) {
    return resolveAssetSpec(config, detectSymbol(algorithm))
  }

  function deriveEligibility(results: Results): Results["eligibilityStatus"] {
    const spec = results.v2?.run_metadata?.asset_spec as any
    if (spec?.assetClass === "option" || spec?.productionEligible === false) return "backtested"
    const exec = results.v2?.execution_config as any
    if (spec?.assetClass === "crypto_perp" && (!exec?.funding_enabled || !exec?.liquidation_enabled)) return "backtested"
    const quality = evaluateBacktestQuality(results)
    if (quality.label === "paper_eligible" || quality.label === "candidate") return "robustness_passed"
    return "backtested"
  }

  function hasProductRiskContract(config: Record<string, any>): boolean {
    const risk = config.risk_contract
    return Boolean(
      risk &&
      typeof risk === "object" &&
      Number.isFinite(risk.sizing_stop_distance_pct) &&
      risk.sizing_stop_distance_pct > 0 &&
      risk.protective_stop &&
      ["none", "strategy_next_open", "engine_stop"].includes(risk.protective_stop.mode) &&
      risk.drawdown &&
      ["evaluation_only", "halt_and_flatten_next_open"].includes(risk.drawdown.mode) &&
      Number.isFinite(risk.drawdown.limit_pct) &&
      risk.drawdown.limit_pct > 0 &&
      Number.isSafeInteger(risk.max_positions) &&
      risk.max_positions > 0
    )
  }

  async function persistStrictRunArtifacts(input: {
    tmpDir: string
    runId: string
    algorithm: Algorithm.Info
    config: any
    validation: Validate.Result
    results: Results
    duration: string
    interval: string
    capital: string
    seed: number
    startDate: string
    endDate: string
  }): Promise<string> {
    const version = Number((input.algorithm as any).version ?? 0) || 0
    const base = path.join(
      finnyArtifactPath("algorithms"),
      input.algorithm.algorithmId,
      `v${String(version).padStart(2, "0")}`,
      "runs",
      input.runId,
    )
    const assetSpec = buildArtifactAssetSpec(input.config, input.algorithm)
    if (!input.validation.valid) throw new Error("strict run cannot be published from failed validation")
    const quality = evaluateBacktestQuality(input.results)
    const walkForward = deriveWalkForwardVerdict(input.results.v2?.walk_forward)
    const recommendation = composeBacktestVerdict({
      quality,
      walkForward,
      consistency: input.results.v2?.consistency,
      decay: input.results.v2?.alpha_decay,
    })
    const current = await RunIntegrity.currentAlgorithmHashes(input.algorithm)
    const rawDataPath = path.join(input.tmpDir, "ohlcv.csv")
    const processedDataPath = path.join(input.tmpDir, PROCESSED_OHLCV_CSV)
    const executionProfile = input.results.v2?.execution_config ?? input.config.execution ?? {}
    const engineTree = await RunIntegrity.directoryTreeManifest(path.join(input.tmpDir, "engine_v2"))
    await RunIntegrity.publishStrictRun({
      finalDir: base,
      runId: input.runId,
      productLabel: input.results.productLabel ?? "Crucible 2.0",
      identity: {
        algorithmId: input.algorithm.algorithmId,
        algorithmVersion: version,
        strategyHash: current.strategyHash,
        savedConfigHash: current.savedConfigHash,
        effectiveConfigHash: RunIntegrity.sha256Text(RunIntegrity.stableStringify(input.config)),
        documentHashes: current.documentHashes,
        riskContractHash: current.riskContractHash,
        rawDataHash: await RunIntegrity.sha256File(rawDataPath),
        processedDataHash: await RunIntegrity.sha256File(processedDataPath),
        manifestHash: await RunIntegrity.sha256File(path.join(input.tmpDir, VERIFIED_MANIFEST_ARTIFACT)),
        engineTreeHash: RunIntegrity.sha256Text(RunIntegrity.stableStringify(engineTree)),
        assetProfileHash: RunIntegrity.sha256Text(RunIntegrity.stableStringify(assetSpec)),
        executionProfileHash: RunIntegrity.sha256Text(RunIntegrity.stableStringify(executionProfile)),
        seed: input.seed,
        dateWindow: { start: input.startDate, end: input.endDate, interval: input.interval },
      },
      recommendation,
      jsonArtifacts: {
        "validation.json": input.validation,
        "metrics.json": input.results,
        "data_quality.json": input.results.v2?.data_quality ?? {},
        "execution_assumptions.json": input.results.diagnostics?.assumptions ?? executionProfile,
        "execution_profile.json": executionProfile,
        "effective_config.json": input.config,
        "engine_tree.json": engineTree,
        "asset_spec.json": assetSpec,
      },
      artifacts: [
        { source: path.join(input.tmpDir, "results.json"), path: "results.json" },
        { source: rawDataPath, path: "ohlcv.csv" },
        { source: path.join(input.tmpDir, VERIFIED_MANIFEST_ARTIFACT), path: VERIFIED_MANIFEST_ARTIFACT },
        { source: processedDataPath, path: PROCESSED_OHLCV_CSV },
        { source: path.join(input.tmpDir, "equity.csv"), path: "equity.csv", required: false },
        { source: path.join(input.tmpDir, "finny_evidence_equity.csv"), path: "finny_evidence_equity.csv", required: false },
        { source: path.join(input.tmpDir, "rolling_sharpe.csv"), path: "rolling_sharpe.csv", required: false },
        { source: path.join(input.tmpDir, "trades.csv"), path: "trades.csv", required: false },
        { source: path.join(input.tmpDir, "diagnostics.csv"), path: "diagnostics.csv", required: false },
        { source: path.join(input.tmpDir, "orders.csv"), path: "orders.csv" },
        { source: path.join(input.tmpDir, "fills.csv"), path: "fills.csv" },
        { source: path.join(input.tmpDir, "rejections.csv"), path: "rejections.csv" },
      ],
      requiredArtifacts: [
        "validation.json",
        "metrics.json",
        "data_quality.json",
        "execution_assumptions.json",
        "execution_profile.json",
        "effective_config.json",
        "engine_tree.json",
        "asset_spec.json",
        "results.json",
        "ohlcv.csv",
        VERIFIED_MANIFEST_ARTIFACT,
        PROCESSED_OHLCV_CSV,
        "orders.csv",
        "fills.csv",
        "rejections.csv",
      ],
    })

    input.results.runId = input.runId
    input.results.artifactDir = base
    input.results.eligibilityStatus = deriveEligibility(input.results)
    return base
  }

  /** Best-effort sweep of stale tmpdirs from prior runs (>1h old). Never throws. */
  async function sweepStaleTmpdirs(): Promise<void> {
    try {
      const dir = os.tmpdir()
      const entries = await fs.readdir(dir)
      const cutoff = Date.now() - 60 * 60 * 1000
      await Promise.all(entries
        .filter(name => name.startsWith("finny-backtest-"))
        .map(async name => {
          const p = path.join(dir, name)
          try {
            const st = await fs.stat(p)
            if (st.mtimeMs < cutoff) await fs.rm(p, { recursive: true, force: true })
          } catch {}
        }))
    } catch {}
  }
  let sweepDone = false

  export async function run(params: Params): Promise<RunResult> {
    const {
      algorithm,
      duration,
      interval,
      capital,
      startDate,
      endDate,
      configOverrides,
      seed,
      engineMode = "strict_v2",
      dataQualityMode = "strict",
      source = "run",
      robustness = {},
      sessionID,
      dataSource = { kind: "provider_fetch" },
    } = params
    // One-shot sweep so stale tmpdirs from prior crashed runs don't accumulate.
    if (!sweepDone) { sweepDone = true; void sweepStaleTmpdirs() }
    const parsedCapital = parseCapital(capital)
    if (parsedCapital === null) {
      return { ok: false, error: `Invalid capital "${capital}". Use a positive finite number.`, kind: "invalid_input" }
    }
    if (engineMode !== "strict_v2" && process.env[PRODUCT_ALLOW_LEGACY_ENV] !== "1") {
      return {
        ok: false,
        error: `Legacy/custom backtest execution is disabled in product flows. Set ${PRODUCT_ALLOW_LEGACY_ENV}=1 only for internal migration tests.`,
        kind: "unsafe_custom_runner",
      }
    }
    if (engineMode === "strict_v2" && algorithm.backtestCode && algorithm.backtestCode.trim().length > 0) {
      return {
        ok: false,
        error: "This algorithm has custom backtestCode, which is disabled in strict_v2 mode because custom runners can forge metrics. Migrate the strategy to engine_v2 or explicitly use legacy_unsafe from an internal/dev caller.",
        kind: "unsafe_custom_runner",
      }
    }
    if (engineMode === "strict_v2" && sessionID && dataSource.kind !== "verified_artifact") {
      return {
        ok: false,
        error:
          "Session-backed strict backtests require the exact verified data_extractor artifact. " +
          "Pass dataSource.kind=verified_artifact from the session evidence gate; provider_fetch is internal-only.",
        kind: "data_evidence",
      }
    }

    // Fallbacks: synthesize default backtest.py and config.json if the algo is missing them.
    const backtestCode = algorithm.backtestCode && algorithm.backtestCode.trim().length > 0
      ? algorithm.backtestCode
      : DEFAULT_BACKTEST_PY
    const algorithmConfig = algorithm.config && algorithm.config.trim().length > 0
      ? algorithm.config
      : synthesizeConfig(algorithm)

    let effectiveConfig: any
    try {
      effectiveConfig = JSON.parse(algorithmConfig)
    } catch {
      return { ok: false, error: "Failed to parse algorithm config JSON.", kind: "config_invalid" }
    }
    effectiveConfig.risk = effectiveConfig.risk ?? {}
    effectiveConfig.risk.starting_equity_usd = parsedCapital
    if (effectiveConfig.symbol) {
      try {
        effectiveConfig.symbol = normalizeSymbol(String(effectiveConfig.symbol))
      } catch (e) {
        if (e instanceof UnknownSymbolError) {
          return { ok: false, error: e.message, kind: "unknown_symbol", suggestions: e.suggestions }
        }
        throw e
      }
    }
    if (robustness.walkForwardFolds && robustness.walkForwardFolds > 0) {
      const historyBars = (effectiveConfig as any).required_history_bars
      if (!Number.isInteger(historyBars) || historyBars < 0) {
        return {
          ok: false,
          error: "Walk-forward robustness requires config.required_history_bars as a non-negative integer.",
          kind: "config_invalid",
        }
      }
    }
    applyConfigOverrides(effectiveConfig, configOverrides)
    if (!effectiveConfig.symbol || typeof effectiveConfig.symbol !== "string" || effectiveConfig.symbol.trim() === "") {
      return {
        ok: false,
        error: "Missing symbol. Set params or save config with symbol before backtest.",
        kind: "config_invalid",
      }
    }
    if (effectiveConfig.symbol) {
      try {
        effectiveConfig.symbol = normalizeSymbol(String(effectiveConfig.symbol))
      } catch (e) {
        if (e instanceof UnknownSymbolError) {
          return { ok: false, error: e.message, kind: "unknown_symbol", suggestions: e.suggestions }
        }
        throw e
      }
    }
    let assetSpec
    try {
      assetSpec = resolveAssetSpec(effectiveConfig, detectSymbol(algorithm))
    } catch (e: any) {
      return { ok: false, error: `Invalid asset specification: ${e?.message ?? String(e)}`, kind: "config_invalid" }
    }
    if (assetSpec.assetClass === "option" && process.env.FINNY_ALLOW_EXPERIMENTAL_OPTIONS !== "1") {
      return {
        ok: false,
        error: `Options backtests are experimental and blocked from product flows. ${assetSpec.blockingReason}`,
        kind: "validation_failed",
      }
    }
    effectiveConfig.asset_class = assetSpec.assetClass
    effectiveConfig.asset_spec = assetSpec

    if (dataSource.kind === "verified_artifact") {
      let issue: string | undefined
      if (!isVerifiedDatasetRef(dataSource.dataset)) {
        issue = "verified data reference was not issued by the data_extractor evidence gate"
      } else {
        try {
          issue = verifiedDatasetIdentityIssue({
            dataset: dataSource.dataset,
            symbol: effectiveConfig.symbol,
            interval,
            assetClass: assetSpec.assetClass,
          })
        } catch (error: any) {
          issue = `verified data identity is invalid: ${error?.message ?? String(error)}`
        }
      }
      if (issue) return { ok: false, error: issue, kind: "data_evidence" }
    }

    const validation = await Validate.run(algorithm.code, { config: effectiveConfig })
    if (!validation.valid) {
      return {
        ok: false,
        error: `Strategy validation failed before backtest.\n${Validate.format(validation)}`,
        kind: "validation_failed",
      }
    }

    const runId = makeRunId()

    let tmpDir: string | undefined
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-backtest-"))

      // Write finny_broker.py — SimBroker + load_strategy() used by the
      // DEFAULT_BACKTEST_PY shim and by algorithms with custom backtestCode.
      await fs.writeFile(path.join(tmpDir, "finny_broker.py"), FINNY_BROKER_PY)

      // Write strategy.py
      await fs.writeFile(path.join(tmpDir, "strategy.py"), algorithm.code)

      // Write backtest.py (user-supplied or DEFAULT shim → finny_broker.SimBroker)
      await fs.writeFile(path.join(tmpDir, "backtest.py"), backtestCode)

      // Copy engine_v2/ into the tmpdir — only needed by algorithms with
      // custom backtestCode that imports engine_v2. The default shim uses
      // finny_broker.py directly, so a missing engine_v2 is non-fatal.
      const ENGINE_V2_SRC = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..", "..", "engine_v2",
      )
      let engineV2Ready = false
      try {
        await fs.cp(ENGINE_V2_SRC, path.join(tmpDir, "engine_v2"), { recursive: true })
        engineV2Ready = true
      } catch {
        engineV2Ready = await materializeBundledEngineV2(path.join(tmpDir, "engine_v2"))
      }
      if (engineMode === "strict_v2" && !engineV2Ready) {
        return {
          ok: false,
          error: `engine_v2 source not found at ${ENGINE_V2_SRC}; strict backtests cannot run.`,
          kind: "internal",
        }
      }

      const config = JSON.parse(JSON.stringify(effectiveConfig))

      await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2))

      // Compute dates and symbol — explicit start/end win over duration-derived window.
      const computed = computeDateRange(duration)
      const start = startDate ?? computed.start
      const end = endDate ?? computed.end
      const symbol = String(config.symbol)
      const assetClass = String(config.asset_class ?? config.assetClass ?? assetSpec.assetClass)
      const providerInterval = INTERVAL_MAP[interval] ?? "1h"
      const csvPath = "ohlcv.csv"

      // Harness mode fixes the seed and may replace the provider-fetch branch
      // with one rehashed local CSV. It never overrides a verified artifact,
      // and both gates are required so it cannot become a production fallback.
      const fixtureCsv =
        process.env.FINNY_HARNESS_MODE === "1" && process.env.FINNY_HARNESS_FIXTURE_MARKET_DATA === "1"
          ? process.env.FINNY_HARNESS_MARKET_DATA_CSV
          : undefined
      if (process.env.FINNY_HARNESS_FIXTURE_MARKET_DATA === "1" && process.env.FINNY_HARNESS_MODE !== "1") {
        return {
          ok: false,
          error: "Harness fixture market data was configured outside FINNY_HARNESS_MODE.",
          kind: "internal",
        }
      }
      const effectiveSeed = fixtureCsv
        ? 424242
        : seed ?? hashSeed(
            algorithm.algorithmId,
            String((algorithm as any).version ?? ""),
            duration,
            interval,
            start,
            end,
            capital,
            stableStringify(configOverrides ?? {}),
            stableStringify(config.execution ?? {}),
          )

      // Bind and copy verified bytes before any Python environment work. A
      // stale/tampered artifact fails without installing packages or spawning
      // a subprocess.
      let preparedData: PreparedBacktestData | undefined
      if (dataSource.kind === "verified_artifact") {
        try {
          preparedData = await prepareBacktestData({ dataSource, tmpDir })
        } catch (error) {
          return dataPreparationFailure(error, dataSource)
        }
      }

      // Use the managed venv. Data-provider packages are installed once, lazily, on first use.
      let pythonCmd: string
      try {
        const env = sessionID
          ? await resolveSessionPythonEnv(sessionID, SESSION_PREFLIGHT_PACKAGES)
          : await ensurePythonEnv([
              { spec: "numpy", importCheck: "numpy" },
              { spec: "pandas", importCheck: "pandas" },
              { spec: "yfinance", importCheck: "yfinance" },
              { spec: "requests", importCheck: "requests" },
              { spec: "scipy", importCheck: "scipy" },
              { spec: "pyarrow", importCheck: "pyarrow" },
            ])
        pythonCmd = env.python
      } catch (e: any) {
        return {
          ok: false,
          error: e?.message ?? "Failed to set up the managed Python environment.",
          kind: "python_env",
        }
      }

      if (!preparedData) {
        try {
          preparedData = await prepareBacktestData({
            dataSource,
            tmpDir,
            fetchProvider: async () => {
              if (fixtureCsv) {
                const bytes = await fs.readFile(fixtureCsv)
                const actual = crypto.createHash("sha256").update(bytes).digest("hex")
                const expected = process.env.FINNY_HARNESS_MARKET_DATA_SHA256?.toLowerCase()
                if (!expected || actual !== expected) {
                  throw new BacktestDataPreparationError(
                    "Harness fixture market-data hash mismatch.",
                    "data_evidence",
                  )
                }
                await fs.writeFile(path.join(tmpDir!, csvPath), bytes)
                await fs.writeFile(path.join(tmpDir!, "_data_provider.txt"), "finny-harness-fixture\n")
                return {
                  providerUsed: "finny-harness-fixture",
                  provenance: {
                    mode: "provider_fetch",
                    provider: "finny-harness-fixture",
                    fixture_sha256: actual,
                  },
                }
              }
              // Provider fetching is deliberately confined to this branch. A
              // verified_artifact run never writes or executes _fetch_data.py.
              const fetchScript = makeFetchDataScript(symbol, assetClass, start, end, providerInterval, csvPath)
              await fs.writeFile(path.join(tmpDir!, "_fetch_data.py"), fetchScript)
              const dataEnv = await alpacaDataEnv()
              const fetchResult = await Process.run([pythonCmd, "_fetch_data.py"], {
                cwd: tmpDir,
                env: dataEnv,
                nothrow: true,
                timeout: 120_000,
              })

              if (fetchResult.code !== 0) {
                const stderr = fetchResult.stderr.toString().trim()
                const { kind, detail } = classifyFetchError(stderr)
                const human =
                  kind === "unknown_symbol"
                    ? `Backtest failed (unknown_symbol): ${symbol} is not a recognized symbol. ` +
                      `Try one of: ${SUPPORTED_CANONICAL.join(", ")}.`
                    : kind === "empty_window"
                      ? `Backtest failed (empty_window): no bars for ${symbol} between ${start} and ${end} at ${providerInterval}. Try a wider duration or a coarser interval.`
                      : kind === "network"
                        ? `Backtest failed (network): could not reach the market data provider. ${detail}`
                        : kind === "auth"
                          ? `Backtest failed (auth): Alpaca credentials/feed access were rejected. ${detail}`
                          : kind === "python_env"
                            ? `Backtest failed (python_env): ${detail}`
                            : `Backtest failed: ${detail || "unknown error"}`
                throw new BacktestDataPreparationError(
                  human,
                  kind,
                  kind === "unknown_symbol" ? SUPPORTED_CANONICAL : undefined,
                )
              }

              const providerUsed = (
                await fs.readFile(path.join(tmpDir!, "_data_provider.txt"), "utf8").catch(() => "")
              ).trim()
              return {
                providerUsed,
                provenance: { mode: "provider_fetch", provider: providerUsed || undefined },
              }
            },
          })
        } catch (error) {
          return dataPreparationFailure(error, dataSource)
        }
      }

      const providerUsed = preparedData.providerUsed
      if (providerUsed) {
        config.data_provider = providerUsed
        if (config.asset_spec && typeof config.asset_spec === "object") {
          config.asset_spec.dataProvider = providerUsed
        }
        await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2))
      }

      const childEnv = { FINNY_SEED: String(effectiveSeed) }
      if (engineMode === "strict_v2") {
        const engineArgs = [
          pythonCmd,
          "-m",
          "engine_v2.cli",
          "--csv",
          csvPath,
          "--config",
          "config.json",
          "--interval",
          interval,
          "--capital",
          String(parsedCapital),
          "--out",
          ".",
          "--mode",
          "v2",
          "--seed",
          String(effectiveSeed),
          "--mc-paths",
          String(robustness.monteCarloPaths ?? 500),
          "--data-quality-mode",
          dataQualityMode,
        ]
        if (start) {
          engineArgs.push("--start-date", start)
        }
        if (end) {
          engineArgs.push("--end-date", end)
        }
        if (robustness.regimes ?? true) engineArgs.push("--regimes")
        if (robustness.walkForwardFolds && robustness.walkForwardFolds > 0) {
          engineArgs.push("--wf-folds", String(robustness.walkForwardFolds))
          engineArgs.push("--prior-selection-trials", String(Math.max(0, robustness.priorSelectionTrials ?? 0)))
          if (robustness.currentSelectionTrials !== undefined) {
            engineArgs.push("--current-selection-trials", String(Math.max(0, robustness.currentSelectionTrials)))
          }
        }
        if (robustness.parameterGrid) {
          engineArgs.push("--param-grid-json", JSON.stringify(robustness.parameterGrid))
        }

        const engineResult = await Process.run(engineArgs, {
          cwd: tmpDir,
          nothrow: true,
          timeout: 300_000,
          env: childEnv,
        })

        const OUTPUT_CAP = 10 * 1024 * 1024
        if (engineResult.stdout.length > OUTPUT_CAP || engineResult.stderr.length > OUTPUT_CAP) {
          emit({
            eventType: "backtest.failed",
            algorithmId: algorithm.algorithmId,
            payload: { error: "engine_output_exceeded_cap", kind: "results_unparseable", duration, interval, capital },
          })
          return {
            ok: false,
            error: `Strict engine produced too much output (cap ${OUTPUT_CAP / 1024 / 1024} MB).`,
            kind: "results_unparseable",
          }
        }

        if (engineResult.code !== 0) {
          const stderr = engineResult.stderr.toString().trim()
          emit({
            eventType: "backtest.failed",
            algorithmId: algorithm.algorithmId,
            payload: { error: stderr || "engine_v2 failed", kind: "engine_invariant", duration, interval, capital },
          })
          return { ok: false, error: `Strict engine failed: ${stderr || "unknown error"}`, kind: "engine_invariant" }
        }

        const results = await parseResults(engineResult.stdout.toString(), tmpDir!, false)
        if (!results || !results.v2) {
          emit({
            eventType: "backtest.failed",
            algorithmId: algorithm.algorithmId,
            payload: { error: "missing_engine_v2_results_json", kind: "results_unparseable", duration, interval, capital },
          })
          return { ok: false, error: "Strict engine did not produce a valid engine_v2 results.json.", kind: "results_unparseable" }
        }
        attachDataSourceProvenance(results, preparedData.provenance)
        // Keep the engine-native artifact aligned with the enriched in-memory
        // result and metrics.json; provenance must not disappear when a
        // consumer reads results.json directly.
        await fs.writeFile(path.join(tmpDir, "results.json"), JSON.stringify(results.v2, null, 2))
        const assumptions = benchmarkAssumptions(results)
        const benchmark = await attachBuyHoldBenchmark({
          tmpDir,
          algorithm,
          config,
          results,
          capital,
          interval,
          assumptions,
          calendar: assetSpec.calendar,
        })
        await persistBacktestEvidenceOrReport({
          tmpDir,
          runId,
          algorithm,
          config,
          results,
          duration,
          interval,
          capital,
          startDate: start,
          endDate: end,
          source,
          benchmark,
          calendar: assetSpec.calendar,
        })
        if (dataSource.kind === "verified_artifact" && hasProductRiskContract(config)) {
          await persistStrictRunArtifacts({
            tmpDir,
            runId,
            algorithm,
            config,
            validation,
            results,
            duration,
            interval,
            capital,
            seed: effectiveSeed,
            startDate: start,
            endDate: end,
          })
        } else {
          // Internal provider fetches remain useful for research, but they do
          // not produce an immutable product run and can never be promoted.
          // The same fail-closed rule applies to legacy v3 algorithms that do
          // not own a schema-v4 executable risk contract.
          results.runKind = "legacy"
          results.eligibilityStatus = "backtested"
          results.v2.run_metadata = {
            ...(results.v2.run_metadata ?? {}),
            product_eligibility_blockers: [
              ...(dataSource.kind !== "verified_artifact" ? ["provider_fetch_research_only"] : []),
              ...(!hasProductRiskContract(config) ? ["schema_v4_risk_contract_required"] : []),
            ],
          }
        }

        emit({
          eventType: "backtest.completed",
          algorithmId: algorithm.algorithmId,
          payload: {
            productLabel: results.productLabel ?? "Crucible 2.0",
            runKind: results.runKind ?? "crucible_2_0",
            duration,
            interval,
            capital,
            engineVersion: results.engineVersion,
            schemaVersion: results.schemaVersion,
            totalReturn: results.totalReturn,
            maxDrawdown: results.maxDrawdown,
            sharpeRatio: results.sharpeRatio,
            totalTrades: results.totalTrades,
            benchmarkReturn: results.benchmarkReturn,
            alpha: results.alpha,
            evidenceDir: results.evidenceDir,
            evidenceError: results.evidenceError,
            eligibilityStatus: results.eligibilityStatus,
            diagnostics: {
              barsProcessed: results.diagnostics?.barsProcessed,
              liquidationCount: results.liquidationCount,
              dataQuality: results.v2.data_quality,
            },
          },
        })
        return { ok: true, results }
      }

      // Pre-flight signal scan — fast dry run to detect 0-signal strategies
      // before spending time on a full backtest.
      const scanResult = await Process.run(
        [pythonCmd, "backtest.py", "--csv", csvPath, "--config", "config.json", "--interval", interval, "--capital", capital, "--scan-only"],
        { cwd: tmpDir, nothrow: true, timeout: 60_000, env: childEnv },
      )
      if (scanResult.code === 0) {
        const scanOut = scanResult.stdout.toString()
        const scanBuys = parseInt(scanOut.match(/scan_buy_signals:\s*(\d+)/)?.[1] ?? "1", 10)
        const scanErrors = parseInt(scanOut.match(/scan_strategy_errors:\s*(\d+)/)?.[1] ?? "0", 10)
        const scanBars = parseInt(scanOut.match(/scan_bars_total:\s*(\d+)/)?.[1] ?? "0", 10)
        // Only short-circuit if zero signals AND no strategy errors (errors could mask real signals)
        if (scanBuys === 0 && scanBars > 0 && scanErrors === 0) {
          const results: Results = {
            totalReturn: 0, maxDrawdown: 0, annualizedVolatility: 0, sharpeRatio: 0,
            endingEquity: parsedCapital, totalTrades: 0, winRate: 0, profitFactor: 0,
            engineVersion: ENGINE_VERSION,
            schemaVersion: 3,
            diagnostics: {
              barsProcessed: scanBars, buyAttempts: 0, sellAttempts: 0,
              rejectedOrders: 0, rejectionReasons: {},
              priceFirst: 0, priceLast: 0, priceRangePct: 0, strategyErrors: 0,
            },
            runId,
          }
          await persistBacktestEvidenceOrReport({
            tmpDir,
            runId,
            algorithm,
            config,
            results,
            duration,
            interval,
            capital,
            startDate: start,
            endDate: end,
            source,
            calendar: assetSpec.calendar,
          })
          emit({
            eventType: "backtest.scan_zero_signals",
            algorithmId: algorithm.algorithmId,
            payload: { scanBars, duration, interval, capital, benchmarkReturn: results.benchmarkReturn, alpha: results.alpha },
          })
          return {
            ok: true,
            results,
          }
        }
      }

      // Run backtest — generous wall-clock cap (5 min) for full history runs
      // with many bars. If a strategy infinite-loops on bad logic, this stops
      // the session from being held hostage.
      const backtestResult = await Process.run(
        [pythonCmd, "backtest.py", "--csv", csvPath, "--config", "config.json", "--interval", interval, "--capital", capital],
        {
          cwd: tmpDir,
          nothrow: true,
          timeout: 300_000,
          env: childEnv,
        },
      )

      // Stdout cap — refuse silently corrupted huge outputs. 10 MB is far
      // beyond any realistic metric dump; if we see more, treat as failure
      // rather than risk burning memory parsing a runaway log.
      const STDOUT_CAP = 10 * 1024 * 1024
      if (backtestResult.stdout.length > STDOUT_CAP) {
        emit({
          eventType: "backtest.failed",
          algorithmId: algorithm.algorithmId,
          payload: { error: "stdout_exceeded_cap", kind: "results_unparseable", duration, interval, capital },
        })
        return {
          ok: false,
          error: `Backtest produced ${(backtestResult.stdout.length / 1024 / 1024).toFixed(1)} MB of stdout (cap ${STDOUT_CAP / 1024 / 1024} MB). Strategy likely has a runaway print loop.`,
          kind: "results_unparseable",
        }
      }

      if (backtestResult.code !== 0) {
        const stderr = backtestResult.stderr.toString().trim()
        emit({
          eventType: "backtest.failed",
          algorithmId: algorithm.algorithmId,
          payload: { error: stderr || "unknown error", kind: "internal", duration, interval, capital },
        })
        return { ok: false, error: `Backtest failed: ${stderr || "unknown error"}`, kind: "internal" }
      }

      const stdout = backtestResult.stdout.toString()
      const results = await parseResults(stdout, tmpDir!)
      if (!results) {
        emit({
          eventType: "backtest.failed",
          algorithmId: algorithm.algorithmId,
          payload: { error: "results_unparseable", kind: "results_unparseable", duration, interval, capital },
        })
        return { ok: false, error: "Failed to parse backtest results from output.", kind: "results_unparseable" }
      }
      results.runId = runId
      await persistBacktestEvidenceOrReport({
        tmpDir,
        runId,
        algorithm,
        config,
        results,
        duration,
        interval,
        capital,
        startDate: start,
        endDate: end,
        source,
        calendar: assetSpec.calendar,
      })

      emit({
        eventType: "backtest.completed",
        algorithmId: algorithm.algorithmId,
        payload: {
          duration,
          interval,
          capital,
          engineVersion: results.engineVersion,
          schemaVersion: results.schemaVersion,
          totalReturn: results.totalReturn,
          maxDrawdown: results.maxDrawdown,
          sharpeRatio: results.sharpeRatio,
          totalTrades: results.totalTrades,
          benchmarkReturn: results.benchmarkReturn,
          alpha: results.alpha,
          evidenceDir: results.evidenceDir,
          evidenceError: results.evidenceError,
        },
      })
      return { ok: true, results }
    } catch (e: any) {
      emit({
        eventType: "backtest.failed",
        algorithmId: algorithm.algorithmId,
        payload: { error: e?.message ?? "Unexpected error", kind: "internal", duration, interval, capital },
      })
      return { ok: false, error: e?.message ?? "Unexpected error running backtest.", kind: "internal" }
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
