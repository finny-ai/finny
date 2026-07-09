import type { BacktestQuality } from "./evaluation"
import type { EngineV2 } from "./results"

export type UnifiedVerdict = "failed" | "inconclusive" | "weak" | "candidate" | "recommended_for_paper"
export type WalkForwardVerdict = "robust" | "degraded" | "failed"

const SCORE: Record<UnifiedVerdict, number> = {
  failed: 0,
  inconclusive: 1,
  weak: 2,
  candidate: 3,
  recommended_for_paper: 4,
}

const BY_SCORE = Object.fromEntries(Object.entries(SCORE).map(([k, v]) => [v, k])) as Record<number, UnifiedVerdict>

function minVerdict(a: UnifiedVerdict, b: UnifiedVerdict): UnifiedVerdict {
  return SCORE[a] <= SCORE[b] ? a : b
}

function uplift(verdict: UnifiedVerdict): UnifiedVerdict {
  if (verdict === "weak") return "candidate"
  if (verdict === "candidate") return "recommended_for_paper"
  return verdict
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function failedWalkForward(wf: EngineV2.WalkForwardSummary, stitchedSharpe: number, stitchedReturn: number) {
  if (wf.flagged) return true
  if (stitchedSharpe <= 0) return true
  return stitchedReturn <= 0
}

function startsAsCandidate(label: BacktestQuality["label"]): boolean {
  return label === "candidate" || label === "paper_eligible"
}

function hasDurableProfile(input: {
  walkForward: { verdict: WalkForwardVerdict }
  consistency?: EngineV2.ConsistencyMetrics | null
  decay?: EngineV2.AlphaDecayMetrics | null
}): boolean {
  return [
    input.walkForward.verdict === "robust",
    input.consistency?.label === "consistent",
    input.decay?.label === "stable",
  ].every(Boolean)
}

export function deriveWalkForwardVerdict(wf: EngineV2.WalkForwardSummary | null | undefined): { verdict: WalkForwardVerdict; reason: string } {
  if (!wf || finite(wf.n_folds, 0) < 2) {
    return { verdict: "failed", reason: "walk-forward robustness did not produce at least 2 folds" }
  }
  const stitchedSharpe = finite(wf.stitched_oos_sharpe ?? wf.oos_sharpe_mean, Number.NEGATIVE_INFINITY)
  const stitchedReturn = finite(wf.stitched_oos_return, Number.NEGATIVE_INFINITY)
  if (failedWalkForward(wf, stitchedSharpe, stitchedReturn)) {
    return {
      verdict: "failed",
      reason: "rolling OOS Sharpe decayed below threshold or stitched OOS performance became non-positive",
    }
  }
  if (finite(wf.oos_decay, 0) < 0.7) {
    return {
      verdict: "degraded",
      reason: `OOS Sharpe retained ${(finite(wf.oos_decay, 0) * 100).toFixed(0)}% of in-sample performance`,
    }
  }
  return { verdict: "robust", reason: "rolling OOS performance is within the robustness threshold" }
}

export function composeBacktestVerdict(input: {
  quality: BacktestQuality
  walkForward: { verdict: WalkForwardVerdict; reason: string }
  consistency?: EngineV2.ConsistencyMetrics | null
  decay?: EngineV2.AlphaDecayMetrics | null
}): { verdict: UnifiedVerdict; reasons: string[] } {
  const reasons: string[] = []
  const q = input.quality
  if (q.label === "failed") {
    return { verdict: "failed", reasons: q.reasons.length ? q.reasons : ["quality gate failed"] }
  }
  if (q.label === "inconclusive") {
    return { verdict: "inconclusive", reasons: q.reasons.length ? q.reasons : ["quality gate inconclusive"] }
  }
  if (input.walkForward.verdict === "failed") {
    return { verdict: "failed", reasons: [input.walkForward.reason] }
  }

  let score: UnifiedVerdict = startsAsCandidate(q.label) ? "candidate" : "weak"
  let cap: UnifiedVerdict = "recommended_for_paper"

  if (input.walkForward.verdict === "degraded") {
    cap = minVerdict(cap, "candidate")
    reasons.push(input.walkForward.reason)
  }

  const consistency = input.consistency
  if (!consistency) {
    cap = minVerdict(cap, "candidate")
    reasons.push("consistency block unavailable")
  } else if (consistency.label === "streak_dependent") {
    cap = minVerdict(cap, "weak")
    reasons.push("returns are streak-dependent")
  } else if (consistency.label === "lumpy") {
    cap = minVerdict(cap, "candidate")
    reasons.push("equity growth is lumpy")
  } else if (consistency.label === "insufficient") {
    cap = minVerdict(cap, "candidate")
    reasons.push("consistency history is insufficient")
  }

  const decay = input.decay
  if (!decay) {
    cap = minVerdict(cap, "candidate")
    reasons.push("alpha-decay block unavailable")
  } else if (decay.label === "decaying") {
    cap = minVerdict(cap, "weak")
    reasons.push("alpha decay is material")
  } else if (decay.label === "mild_decay") {
    cap = minVerdict(cap, "candidate")
    reasons.push("alpha decay is mild")
  } else if (decay.label === "insufficient") {
    cap = minVerdict(cap, "candidate")
    reasons.push("alpha-decay history is insufficient")
  }

  if (hasDurableProfile(input)) {
    const before = score
    score = uplift(score)
    if (before !== score) reasons.push(before === "weak" ? "modest absolute edge but durable" : "durable robustness supports paper review")
  }

  const verdict = BY_SCORE[Math.min(SCORE[score], SCORE[cap])]
  return { verdict, reasons: reasons.length ? reasons : ["all durability gates passed"] }
}
