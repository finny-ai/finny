import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { Algorithm } from "@/algorithm"
import type { BacktestRunner } from "../runner"
import type { EngineV2 } from "../results"
import { LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST, leanExecutionProfileV1, runtimeProfileV1, strategySourceV1 } from "./contracts"
import { materializeLeanDataBundle } from "./materialize"
import { parseFinnyOhlcv, writeLeanMarketData } from "./data-writer"
import { parseLeanResultJson } from "./lean-result-parse"
import { buildCanonicalMetrics } from "./metrics"
import { LeanAdapter } from "./adapter"
import { readLeanSourceFile } from "./source-store"
import type { LeanBarScheduleV1 } from "./types"

function csvTimestamps(csvPath: string): Promise<string[]> {
  return fs.readFile(csvPath, "utf8").then((text) => {
    const lines = text.split(/\r?\n/).filter((line) => line.trim())
    const header = lines[0]?.split(",").map((v) => v.trim().toLowerCase()) ?? []
    const index = header.indexOf("timestamp")
    if (index < 0) throw new Error("ohlcv.csv has no timestamp column")
    return lines.slice(1).map((line) => {
      const raw = line.split(",")[index]?.trim().replace(/^"|"$/g, "")
      const parsed = Date.parse(raw)
      if (!Number.isFinite(parsed)) throw new Error("ohlcv.csv contains an invalid timestamp")
      return new Date(parsed).toISOString()
    })
  })
}

export type LeanEngineRunResult =
  | { ok: true; results: BacktestRunner.Results; v2: EngineV2.Results }
  | { ok: false; kind: "engine_crash" | "results_unparseable" | "data_bundle_invalid" | "source_missing" | "internal"; error: string }

/**
 * Executes one LEAN backtest inside the runner: prepares the source tree and
 * data bundle, runs the pinned container through the adapter, parses the
 * engine result packet, and computes canonical metrics. Returns results in the
 * same shape engine_v2 produces so all downstream gates and persistence work
 * unchanged.
 */
export async function runLeanEngineInRunner(input: {
  tmpDir: string
  algorithm: Algorithm.Info
  config: Record<string, any>
  csvPath: string
  interval: string
  capital: number
  seed: number
  startDate: string
  endDate: string
}): Promise<LeanEngineRunResult> {
  const assetClass = String(input.config.asset_class ?? "equity").toLowerCase().includes("crypto")
    ? "crypto_spot"
    : "equity"
  const symbol = String(input.config.symbol ?? "SPY")
  const sourceDir = path.join(input.tmpDir, "lean-source")
  const resultsDir = path.join(input.tmpDir, "lean-results")
  const scratchDir = path.join(input.tmpDir, "lean-scratch")
  await Promise.all([
    fs.mkdir(sourceDir, { recursive: true }),
    fs.mkdir(resultsDir, { recursive: true }),
    fs.mkdir(scratchDir, { recursive: true }),
  ])

  let mainPy: string
  try {
    mainPy = await readLeanSourceFile({ algorithm: input.algorithm, relativePath: "main.py" })
  } catch {
    return {
      ok: false,
      kind: "source_missing",
      error: `LEAN source main.py is missing for ${input.algorithm.name} v${input.algorithm.version}`,
    }
  }
  await fs.writeFile(path.join(sourceDir, "main.py"), mainPy, "utf8")

  let timestamps: string[]
  try {
    timestamps = await csvTimestamps(path.join(input.tmpDir, input.csvPath))
  } catch (error) {
    return { ok: false, kind: "data_bundle_invalid", error: String(error) }
  }
  let rows
  try {
    rows = parseFinnyOhlcv(await fs.readFile(path.join(input.tmpDir, input.csvPath), "utf8"))
    const dataDir = scratchDir
    await writeLeanMarketData({
      rows,
      symbol,
      assetClass,
      interval: input.interval,
      dataDir,
    })
  } catch (error) {
    return { ok: false, kind: "data_bundle_invalid", error: `LEAN data materialization failed: ${String(error)}` }
  }
  const schedule: LeanBarScheduleV1 = {
    symbol,
    assetClass,
    interval: input.interval,
    calendarId: assetClass === "equity" ? "XNYS" : "24-7",
    calendarVersion: "finny-calendars-2026.1",
    timezone: assetClass === "equity" ? "America/New_York" : "UTC",
    bars: timestamps.map((timestamp) => ({ timestamp, sessionId: timestamp.slice(0, 10) })),
    scheduleHash: crypto.createHash("sha256").update(timestamps.join("\n")).digest("hex"),
  }

  let dataBundle
  try {
    dataBundle = await materializeLeanDataBundle({
      phase: "exploratory",
      interval: input.interval,
      assetFamily: assetClass,
      schedules: [schedule],
      window: { start: input.startDate, end: input.endDate },
      warmupBars: Number(input.config.required_history_bars ?? 0),
      outputDir: scratchDir,
    })
  } catch (error) {
    return { ok: false, kind: "data_bundle_invalid", error: `data bundle materialization failed: ${String(error)}` }
  }

  const profile = runtimeProfileV1("lean_python")
  const executionProfile = leanExecutionProfileV1({
    assetClass,
    makerFeeBps: Number(input.config.execution?.maker_fee_bps ?? 0),
    takerFeeBps: Number(input.config.execution?.taker_fee_bps ?? 0),
    slippageBps: Number(input.config.execution?.slippage_bps ?? 0),
    maxLeverage: Number(input.config.execution?.max_leverage ?? 1),
    maintenanceMarginPct: Number(input.config.execution?.maintenance_margin_pct ?? 0.5),
    shortingEnabled: false,
    dataFeedWorkers: 1,
  })
  const source = strategySourceV1({
    profileId: "lean_python",
    files: [{ path: "main.py", sha256: crypto.createHash("sha256").update(mainPy).digest("hex"), bytes: Buffer.byteLength(mainPy, "utf8") }],
  })

  const adapter = new LeanAdapter()
  const outcome = await adapter.run({
    plan: {} as any,
    bundle: {
      schema: "finny.lean_runtime_bundle",
      version: 1,
      profile,
      source,
      executionProfile,
      image: {
        schema: "finny.lean_image_identity",
        version: 1,
        imageRef: "ghcr.io/finny-ai/lean-engine",
        imageDigest: LEAN_PINNED_IMAGE_DIGEST,
        leanCommit: LEAN_PINNED_COMMIT,
        architectures: ["linux/amd64", "linux/arm64"],
        sbomSha256: "",
        provenanceSha256: "",
      },
      leanConfigHash: "",
      adapterHash: "",
      runtimeHash: "",
    },
    dataBundle,
    phase: "exploratory",
    window: { start: input.startDate, end: input.endDate },
    seed: input.seed,
    sourceDir,
    resultsDir,
    scratchDir,
  })
  if (!outcome.ok) {
    return {
      ok: false,
      kind: outcome.kind as "engine_crash" | "results_unparseable" | "data_bundle_invalid" | "source_missing" | "internal",
      error: outcome.error,
    }
  }

  let resultJson: string
  let summaryJson: string
  try {
    resultJson = await fs.readFile(path.join(resultsDir, "Main.json"), "utf8")
    summaryJson = await fs.readFile(path.join(resultsDir, "Main-summary.json"), "utf8").catch(() => "{}")
  } catch {
    return { ok: false, kind: "results_unparseable", error: "LEAN engine produced no Main.json result packet" }
  }
  const parsed = parseLeanResultJson({ text: resultJson, summaryText: summaryJson })
  if (parsed.equityCurve.length === 0 && parsed.orders.length === 0 && parsed.fills.length === 0) {
    return { ok: false, kind: "results_unparseable", error: "LEAN result packet contained no orders, fills, or equity series" }
  }

  const v2 = buildCanonicalMetrics({
    equityCurve: parsed.equityCurve,
    fills: parsed.fills,
    orders: parsed.orders,
    rejections: parsed.rejections,
    startingEquity: input.capital,
    seed: input.seed,
    interval: input.interval,
    startTs: new Date(`${input.startDate}T00:00:00Z`).toISOString(),
    endTs: new Date(`${input.endDate}T23:59:59Z`).toISOString(),
    symbols: [symbol],
    ohlcvRows: timestamps.length,
    engineVersion: `lean-${LEAN_PINNED_COMMIT.slice(0, 8)}`,
  })
  const statsFees = Number(parsed.statistics?.["Total Fees"] ?? 0)
  if (Number.isFinite(statsFees) && statsFees > 0) {
    v2.exposure.total_fees = statsFees
  }

  // Canonical artifact set consumed by the strict run publisher.
  const writeCsv = async (name: string, rows: Array<Record<string, unknown>>, headers: string[]) => {
    const lines = rows.map((row) => headers.map((h) => String(row[h] ?? "")).join(","))
    await fs.writeFile(path.join(input.tmpDir, name), [headers.join(","), ...lines].join("\n") + "\n", "utf8")
  }
  await writeCsv(
    "orders.csv",
    parsed.orders.map((o) => ({ orderId: o.orderId, symbol: o.symbol, type: o.type, status: o.status, quantity: o.quantity, price: o.price ?? "", tag: o.tag, time: o.time })),
    ["orderId", "symbol", "type", "status", "quantity", "price", "tag", "time"],
  )
  await writeCsv(
    "fills.csv",
    parsed.fills.map((f) => ({ orderId: f.orderId, symbol: f.symbol, direction: f.direction, quantity: f.quantity, price: f.price, fee: f.fee, time: f.time })),
    ["orderId", "symbol", "direction", "quantity", "price", "fee", "time"],
  )
  await writeCsv(
    "rejections.csv",
    parsed.rejections.map((r) => ({ orderId: r.orderId, symbol: r.symbol, type: r.type, status: r.status, quantity: r.quantity, price: r.price ?? "", tag: r.tag, time: r.time })),
    ["orderId", "symbol", "type", "status", "quantity", "price", "tag", "time"],
  )
  await writeCsv(
    "equity.csv",
    parsed.equityCurve.map((p) => ({ timestamp: p.timestamp, equity: p.equity })),
    ["timestamp", "equity"],
  )
  await fs.writeFile(path.join(input.tmpDir, "results.json"), JSON.stringify(v2, null, 2), "utf8")
  await fs.writeFile(path.join(input.tmpDir, "trades.csv"), JSON.stringify(v2.trades, null, 2), "utf8")
  // Processed data is the Finny-attested bytes (no transformation for LEAN);
  // the strict publisher and benchmark attachment require this artifact.
  await fs.copyFile(path.join(input.tmpDir, input.csvPath), path.join(input.tmpDir, "processed_ohlcv.csv"))
  // LEAN engine identity marker so the strict run's engine tree hash reflects
  // the pinned engine rather than engine_v2.
  const engineMarker = path.join(input.tmpDir, "lean-engine")
  await fs.mkdir(engineMarker, { recursive: true })
  await fs.writeFile(path.join(engineMarker, `${LEAN_PINNED_COMMIT.slice(0, 12)}.${LEAN_PINNED_IMAGE_DIGEST.slice(7, 19)}`), "", "utf8")

  const results: BacktestRunner.Results = {
    totalReturn: v2.total_return,
    maxDrawdown: v2.max_drawdown,
    annualizedVolatility: v2.ann_vol,
    sharpeRatio: v2.ann_sharpe,
    endingEquity: v2.ending_equity,
    totalTrades: v2.total_trades,
    closedTrades: v2.total_trades,
    openTradeCount: 0,
    realizedPnl: v2.ending_equity - input.capital,
    unrealizedPnl: 0,
    realizedReturn: input.capital > 0 ? (v2.ending_equity - input.capital) / input.capital : 0,
    unrealizedReturn: 0,
    winRate: v2.win_rate,
    profitFactor: v2.profit_factor,
    sortino: v2.ratios.sortino,
    calmar: v2.ratios.calmar ?? undefined,
    var95: v2.risk.var_95,
    var99: v2.risk.var_99,
    cvar95: v2.risk.cvar_95,
    cvar99: v2.risk.cvar_99,
    ulcerIndex: v2.risk.ulcer_index,
    painIndex: v2.risk.pain_index,
    tailRatio: v2.risk.tail_ratio,
    skew: v2.risk.skew,
    kurtosis: v2.risk.kurtosis,
    liquidationCount: v2.exposure.liquidation_count,
    maxGrossExposure: v2.exposure.max_gross_exposure,
    maxDdDuration: v2.drawdown.max_dd_duration_bars,
    timeInMarket: v2.exposure.time_in_market_pct,
    diagnostics: {
      barsProcessed: v2.bars_processed,
      buyAttempts: parsed.fills.filter((f) => /buy/i.test(f.direction)).length,
      sellAttempts: parsed.fills.filter((f) => /sell/i.test(f.direction)).length,
      rejectedOrders: parsed.rejections.length,
      pendingOrdersAtEnd: 0,
      rejectionReasons: {},
      priceFirst: 0,
      priceLast: 0,
      priceRangePct: 0,
      strategyErrors: 0,
      assumptions: {
        fill_model: "lean-next-eligible-bar-open",
        participation_cap_pct: executionProfile.volumeParticipationCapPct,
        maker_fee_bps: executionProfile.fees.makerFeeBps,
        taker_fee_bps: executionProfile.fees.takerFeeBps,
        slippage_bps: executionProfile.slippageBps,
        max_leverage: executionProfile.buyingPower.maxLeverage,
        maintenance_margin_pct: executionProfile.buyingPower.maintenanceMarginPct,
      },
    },
    engineVersion: v2.engine_version,
    schemaVersion: 3,
    productLabel: "Crucible 2.0",
    runKind: "crucible_2_0",
    navSummary: {
      mark_to_market_nav: v2.ending_equity,
      liquidation_nav: v2.ending_equity,
      explanation: "Canonical NAV from the LEAN equity series",
    },
    costAttribution: {
      total_costs: v2.exposure.total_fees,
      fees: v2.exposure.total_fees,
      funding: 0,
      borrow: 0,
      cost_as_pct_starting_equity: input.capital > 0 ? v2.exposure.total_fees / input.capital : 0,
      explanation: "Fees from LEAN order events; funding/borrow are zero for v1 assets",
    },
    v2,
  }
  return { ok: true, results, v2 }
}
