import path from "node:path"

export type ArtifactCaptureDecision =
  | { include: true; category: "strict_run" | "algorithm_document" | "market_evidence" | "session" | "log" }
  | { include: false; reason: "runtime_directory" | "compiled_runtime" | "legacy_bulk" | "not_allowlisted" }

export const RUNTIME_DIRECTORIES = new Set([
  ".venv",
  "node_modules",
  "__pycache__",
  ".cache",
  "cache",
  "caches",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".git",
  "site-packages",
])

const COMPILED_RUNTIME_EXTENSIONS = new Set([
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".o",
  ".a",
  ".class",
  ".wasm",
])

const ALGORITHM_DOCUMENTS = new Set([
  "CURRENT",
  "config.json",
  "decisions.md",
  "memory.md",
  "meta.json",
  "mission.md",
  "prefs.md",
  "reasoning.md",
  "risk.json",
  "strategy.py",
])

const STRICT_RUN_FILES = new Set([
  "approval.json",
  "artifact-manifest.json",
  "asset_spec.json",
  "data_extractor.manifest.json",
  "data_quality.json",
  "diagnostics.csv",
  "durability.json",
  "effective_config.json",
  "engine_tree.json",
  "equity.csv",
  "execution_assumptions.json",
  "execution_profile.json",
  "fills.csv",
  "finny_evidence_equity.csv",
  "live-eligibility.json",
  "metrics.json",
  "ohlcv.csv",
  "orders.csv",
  "processed_ohlcv.csv",
  "rejections.csv",
  "results.json",
  "rolling_sharpe.csv",
  "run.json",
  "trades.csv",
  "validation.json",
])

const LEGACY_DOCUMENTS = new Set(["manifest.json", "mission.md", "request.json", "review.md", "review.html"])
const EVIDENCE_EXTENSIONS = new Set([".csv", ".json", ".jsonl", ".md", ".txt", ".log", ".html"])

type PathParts = {
  parts: string[]
  normalized: string
}

function portable(input: { relative: string }): string {
  return input.relative.split(path.sep).join("/")
}

function isStrictRunFile(input: { name: string }): boolean {
  if (STRICT_RUN_FILES.has(input.name)) return true
  return /^finny_evidence_[a-z0-9_-]+\.csv$/i.test(input.name)
}

function decideRunArtifact(input: PathParts): ArtifactCaptureDecision | undefined {
  const runIndex = input.parts.indexOf("runs")
  if (runIndex < 0) return
  const runFile = input.parts.slice(runIndex + 2)
  const strictName = runFile[0] ?? ""
  if (runFile.length === 1 && isStrictRunFile({ name: strictName })) {
    return { include: true, category: "strict_run" }
  }
  return { include: false, reason: "not_allowlisted" }
}

function decideMarketEvidence(input: PathParts): ArtifactCaptureDecision | undefined {
  if (input.parts.indexOf("data") < 0) return
  if (EVIDENCE_EXTENSIONS.has(path.extname(input.normalized).toLowerCase())) {
    return { include: true, category: "market_evidence" }
  }
  return { include: false, reason: "not_allowlisted" }
}

function decideAlgorithmDocument(input: PathParts): ArtifactCaptureDecision {
  if (ALGORITHM_DOCUMENTS.has(input.parts.at(-1)!)) return { include: true, category: "algorithm_document" }
  return { include: false, reason: "not_allowlisted" }
}

function decideAlgorithmPath(input: PathParts): ArtifactCaptureDecision {
  return decideRunArtifact(input) ?? decideMarketEvidence(input) ?? decideAlgorithmDocument(input)
}

function decideLegacyAlgoPath(input: { parts: string[] }): ArtifactCaptureDecision {
  if (input.parts.length === 3 && LEGACY_DOCUMENTS.has(input.parts[2]!)) {
    return { include: true, category: "algorithm_document" }
  }
  return { include: false, reason: "legacy_bulk" }
}

function decideEvidencePath(input: { root: string; normalized: string }): ArtifactCaptureDecision {
  if (!EVIDENCE_EXTENSIONS.has(path.extname(input.normalized).toLowerCase())) {
    return { include: false, reason: "not_allowlisted" }
  }
  if (input.root === "logs") return { include: true, category: "log" }
  if (input.root === "sessions") return { include: true, category: "session" }
  return { include: true, category: "market_evidence" }
}

function runtimeReject(input: PathParts): ArtifactCaptureDecision | undefined {
  if (input.parts.some((part) => RUNTIME_DIRECTORIES.has(part))) {
    return { include: false, reason: "runtime_directory" }
  }
  if (COMPILED_RUNTIME_EXTENSIONS.has(path.extname(input.normalized).toLowerCase())) {
    return { include: false, reason: "compiled_runtime" }
  }
}

function allowlistedPath(input: PathParts): ArtifactCaptureDecision {
  if (input.normalized === "algorithms/_by-name.json") return { include: true, category: "algorithm_document" }
  if (input.parts[0] === "algorithms" && input.parts.length >= 3) return decideAlgorithmPath(input)
  if (input.parts[0] === "algos") return decideLegacyAlgoPath({ parts: input.parts })
  if (input.parts[0] === "session-workspaces" && input.parts.length === 2) {
    return { include: true, category: "session" }
  }
  if (["sessions", "logs", "evidence"].includes(input.parts[0] ?? "")) {
    return decideEvidencePath({ root: input.parts[0]!, normalized: input.normalized })
  }
  return { include: false, reason: "not_allowlisted" }
}

export function artifactCaptureDecision(input: { relative: string }): ArtifactCaptureDecision {
  const normalized = portable({ relative: input.relative })
  const parts = normalized.split("/").filter(Boolean)
  const pathParts = { parts, normalized }
  return runtimeReject(pathParts) ?? allowlistedPath(pathParts)
}
