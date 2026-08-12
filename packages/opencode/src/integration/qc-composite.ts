import fs from "node:fs/promises"
import path from "node:path"
import type { Algorithm } from "@/algorithm"
import type { UnifiedVerdict } from "@/backtest/verdict"
import { runQcCloudBacktest } from "./qc-cloud"
import {
  buildQcCompositeRunIdentity,
  canonicalizeQcStatistics,
  qcProjectUrl,
  type QcCanonicalStatistics,
  type QcCompositeRunIdentityV1,
} from "./qc-contracts"
import { getProjectLink } from "./qc-store"
import { syncBeforeRun } from "./qc-sync"
import { isQcFixtureMode } from "./quantconnect"
import { strictRunDir } from "@/backtest/run-integrity-core"

/**
 * QC Cloud + Crucible composite qualification.
 *
 * QC Cloud is the client's native runtime truth (native QC market data);
 * the pinned local LEAN runtime is Finny's independent audit on attested
 * data. Both must independently pass their own gates. Exact numerical
 * parity is never required because the data providers differ.
 */

export interface QcLocalRunOutcome {
  ok: true
  runId: string
  identityHash: string
  runtimeHash: string
  engine: "lean_python" | "lean_csharp"
  verdict: UnifiedVerdict
  metrics: {
    totalReturn?: number
    sharpe?: number
    maxDrawdown?: number
    totalTrades?: number
  }
}

export interface QcCloudGates {
  passed: boolean
  checks: Array<{ name: string; passed: boolean; detail: string }>
}

export interface QcCompositeOutcome {
  ok: boolean
  error?: string
  mode: "fixture" | "cloud"
  projectId: string
  backtestId?: string
  backtestUrl?: string
  local?: QcLocalRunOutcome
  canonical?: QcCanonicalStatistics
  cloudGates?: QcCloudGates
  identity?: QcCompositeRunIdentityV1
  compositeVerdict?: "recommended_for_paper" | "candidate" | "failed"
}

export const QC_CLOUD_GATE_DEFAULTS = {
  minTotalReturn: 0,
  minTrades: 2,
  maxDrawdownPct: 0.5,
  minSharpe: 0,
} as const

export function evaluateCloudGates(
  canonical: QcCanonicalStatistics,
  policy: Partial<typeof QC_CLOUD_GATE_DEFAULTS> = {},
): QcCloudGates {
  const gates = { ...QC_CLOUD_GATE_DEFAULTS, ...policy }
  const checks: QcCloudGates["checks"] = []
  const totalReturn = canonical.total_return
  checks.push({
    name: "total_return",
    passed: totalReturn !== undefined && totalReturn > gates.minTotalReturn,
    detail: totalReturn === undefined ? "missing" : `${(totalReturn * 100).toFixed(2)}%`,
  })
  const totalTrades = canonical.total_trades
  checks.push({
    name: "total_trades",
    passed: totalTrades !== undefined && totalTrades >= gates.minTrades,
    detail: totalTrades === undefined ? "missing" : String(totalTrades),
  })
  const maxDrawdown = canonical.max_drawdown
  checks.push({
    name: "max_drawdown",
    // canonical.max_drawdown is negative (Finny convention); the gate is a
    // positive magnitude cap, so compare |maxDrawdown| against the limit.
    passed: maxDrawdown !== undefined && Math.abs(maxDrawdown) <= gates.maxDrawdownPct,
    detail: maxDrawdown === undefined ? "missing" : `${(maxDrawdown * 100).toFixed(2)}%`,
  })
  const sharpe = canonical.sharpe
  if (sharpe !== undefined) {
    checks.push({
      name: "sharpe",
      passed: sharpe >= gates.minSharpe,
      detail: sharpe.toFixed(3),
    })
  }
  return { passed: checks.every((check) => check.passed), checks }
}

export function composeCompositeVerdict(
  localVerdict: UnifiedVerdict,
  cloudGates: QcCloudGates,
): "recommended_for_paper" | "candidate" | "failed" {
  if (!cloudGates.passed) return "failed"
  if (localVerdict === "recommended_for_paper") return "recommended_for_paper"
  if (localVerdict === "candidate" || localVerdict === "weak") return "candidate"
  return "failed"
}

export async function writeQcCompositeEvidence(input: {
  runDir: string
  identity: QcCompositeRunIdentityV1
  outcome: Pick<QcCompositeOutcome, "canonical" | "cloudGates" | "compositeVerdict" | "backtestUrl">
}): Promise<string> {
  const file = path.join(input.runDir, "qc-composite.json")
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        schema: "finny.qc_composite_evidence",
        version: 1,
        identity: input.identity,
        canonical: input.outcome.canonical,
        cloudGates: input.outcome.cloudGates,
        compositeVerdict: input.outcome.compositeVerdict,
        backtestUrl: input.outcome.backtestUrl,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  return file
}

/**
 * Run the cloud leg of the composite and bind it to an already-completed
 * local Crucible/LEAN run.
 */
export async function runQcCompositeQualification(input: {
  algorithm: Algorithm.Info
  interval: string
  capital: number
  startDate: string
  endDate: string
  local: QcLocalRunOutcome
  abort?: AbortSignal
  /**
   * OHLCV CSV for the fixture-mode cloud leg. Fixture mode runs the pinned
   * local LEAN engine, so it needs real attested bars; when omitted the
   * local run's processed_ohlcv.csv artifact is used.
   */
  fixtureCsv?: string
}): Promise<QcCompositeOutcome> {
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (!link) {
    return { ok: false, mode: "fixture", projectId: "", error: "algorithm is not linked to a QuantConnect project" }
  }
  const sync = await syncBeforeRun(input.algorithm)
  if (!sync.ok) {
    return {
      ok: false,
      mode: "fixture",
      projectId: String(link.projectId),
      error: `QuantConnect project is not synchronized (${sync.action ?? "blocked"}): ${(sync.drift ?? []).join("; ")}`,
    }
  }

  let config: Record<string, any> = {}
  try {
    config = JSON.parse(input.algorithm.config ?? "{}")
  } catch {}
  const symbol = typeof config.symbol === "string" ? config.symbol : ""
  let fixtureCsv = input.fixtureCsv ?? ""
  if (!fixtureCsv) {
    try {
      fixtureCsv = await fs.readFile(
        path.join(strictRunDir(input.algorithm, input.local.runId), "processed_ohlcv.csv"),
        "utf8",
      )
    } catch {
      fixtureCsv = ""
    }
  }
  if (!fixtureCsv && (await isQcFixtureMode())) {
    return {
      ok: false,
      mode: "fixture",
      projectId: String(link.projectId),
      error:
        "fixture composite requires attested OHLCV bars: the local run directory has no processed_ohlcv.csv and no fixtureCsv was supplied",
    }
  }
  const cloud = await runQcCloudBacktest({
    algorithm: input.algorithm,
    ohlcvCsv: fixtureCsv,
    interval: input.interval,
    capital: input.capital,
    startDate: input.startDate,
    endDate: input.endDate,
    walkForwardFolds: 0,
    parameters: {
      symbol,
      interval: input.interval,
      capital: input.capital,
      start_date: input.startDate,
      end_date: input.endDate,
      finny_run_id: input.local.runId,
      finny_runtime: input.local.engine,
    },
    abort: input.abort,
  })
  if (!cloud.ok || !cloud.stats) {
    return {
      ok: false,
      mode: cloud.mode,
      projectId: cloud.projectId,
      backtestId: cloud.backtestId,
      error: cloud.error ?? "QC Cloud backtest failed",
    }
  }

  const canonical = canonicalizeQcStatistics(
    (cloud.stats.raw as Record<string, string | number> | undefined) ??
      (cloud.stats as Record<string, string | number> | undefined),
  )
  const cloudGates = evaluateCloudGates(canonical)
  const compositeVerdict = composeCompositeVerdict(input.local.verdict, cloudGates)
  const identity = buildQcCompositeRunIdentity({
    algorithmId: input.algorithm.algorithmId,
    algorithmVersion: input.algorithm.version,
    runId: input.local.runId,
    local: {
      runId: input.local.runId,
      identityHash: input.local.identityHash,
      runtimeHash: input.local.runtimeHash,
      engine: input.local.engine,
    },
    cloud: {
      projectId: link.projectId,
      compileId: "",
      backtestId: cloud.backtestId ?? "",
      leanVersionId: link.leanVersionId,
      sourceTreeHash: link.sync.lastRemoteTreeHash,
      parameters: {
        symbol,
        interval: input.interval,
        capital: input.capital,
        start_date: input.startDate,
        end_date: input.endDate,
        finny_run_id: input.local.runId,
        finny_runtime: input.local.engine,
      },
      statistics: cloud.stats,
      backtestUrl: typeof cloud.stats.backtest_url === "string" ? cloud.stats.backtest_url : qcProjectUrl(link.projectId),
    },
  })

  return {
    ok: cloudGates.passed,
    mode: cloud.mode,
    projectId: cloud.projectId,
    backtestId: cloud.backtestId,
    backtestUrl: typeof cloud.stats.backtest_url === "string" ? cloud.stats.backtest_url : undefined,
    local: input.local,
    canonical,
    cloudGates,
    identity,
    compositeVerdict,
  }
}
