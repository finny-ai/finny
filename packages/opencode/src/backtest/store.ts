import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import type { ExperimentReference } from "./experiment"

export type Source = "run" | "walkforward" | "sweep"

export interface Params {
  duration: string
  interval: string
  capital: string
  startDate?: string
  endDate?: string
}

export interface Assumptions {
  feeBps: number
  slippageBps: number
  fillModel: string
}

export interface ResultSummary {
  totalReturn: number
  maxDrawdown: number
  annualizedVolatility: number
  sharpeRatio: number
  endingEquity: number
  totalTrades: number
  winRate: number
  profitFactor: number | null
  productLabel?: string
  runKind?: "crucible_2_0" | "legacy"
  eligibilityStatus?: string
}

export interface BenchmarkSummary {
  kind: "buy_and_hold"
  totalReturn: number
  maxDrawdown: number
  endingEquity: number
  sharpeRatio?: number | null
}

export interface Artifacts {
  equityCurve: string | null
  trades: string | null
  sourceArtifacts?: string | null
  dataSnapshot?: string | null
  processedDataSnapshot?: string | null
  dataQuality?: string | null
  dataProvenance?: string | null
}

export interface Manifest {
  id: string
  dir?: string
  source: Source
  algorithmId: string
  algorithmName: string
  algorithmVersion: number
  symbol?: string
  params: Params
  assumptions: Assumptions
  results: ResultSummary
  benchmark: BenchmarkSummary | null
  alpha: number | null
  artifacts: Artifacts
  timestamp: number
  experiment?: ExperimentReference
}

export interface SaveInput {
  record: Omit<Manifest, "artifacts"> & { artifacts?: Partial<Artifacts> }
  artifacts?: {
    equityCsv?: string
    tradesCsv?: string
    sourceArtifacts?: string
    dataSnapshotCsv?: string
    processedDataSnapshotCsv?: string
    dataQualityJson?: string
    dataProvenanceJson?: string
  }
}

export interface ListInput {
  algorithmName?: string
  algorithmId?: string
  limit?: number
}

const ROOT = path.join(Global.Path.data, "backtests")

interface LegacyBacktestHistoryEntry {
  id?: unknown
  algorithmId?: unknown
  algorithmName?: unknown
  params?: Partial<Record<keyof Params, unknown>>
  results?: Partial<Record<keyof ResultSummary, unknown>>
  symbol?: unknown
  timestamp?: unknown
}

interface ManifestFilters {
  algorithmName?: string
  algorithmId?: string
}

export function rootDir() {
  return ROOT
}

function safeSegment(input: string) {
  const segment = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return segment || "algorithm"
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function nullableFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function paramString(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  return "unknown"
}

function legacyHistoryToManifest(raw: unknown, index: number): Manifest | null {
  if (!raw || typeof raw !== "object") return null
  const entry = raw as LegacyBacktestHistoryEntry
  const algorithmName = optionalString(entry.algorithmName)
  if (!algorithmName || !entry.results || !entry.params) return null

  const timestamp = finite(entry.timestamp, 0)
  const id = optionalString(entry.id) ?? `legacy-${timestamp}-${safeSegment(algorithmName)}-${index}`
  const runKind = entry.results.runKind === "crucible_2_0" ? "crucible_2_0" : "legacy"
  return {
    id,
    source: "run",
    algorithmId: optionalString(entry.algorithmId) ?? "",
    algorithmName,
    algorithmVersion: 0,
    symbol: optionalString(entry.symbol),
    params: {
      duration: paramString(entry.params.duration),
      interval: paramString(entry.params.interval),
      capital: paramString(entry.params.capital),
      startDate: optionalString(entry.params.startDate),
      endDate: optionalString(entry.params.endDate),
    },
    assumptions: { feeBps: 0, slippageBps: 0, fillModel: "legacy" },
    results: {
      totalReturn: finite(entry.results.totalReturn),
      maxDrawdown: finite(entry.results.maxDrawdown),
      annualizedVolatility: finite(entry.results.annualizedVolatility),
      sharpeRatio: finite(entry.results.sharpeRatio),
      endingEquity: finite(entry.results.endingEquity),
      totalTrades: finite(entry.results.totalTrades),
      winRate: finite(entry.results.winRate),
      profitFactor: nullableFinite(entry.results.profitFactor),
      productLabel: optionalString(entry.results.productLabel),
      runKind,
      eligibilityStatus: optionalString(entry.results.eligibilityStatus),
    },
    benchmark: null,
    alpha: null,
    artifacts: { equityCurve: null, trades: null, sourceArtifacts: null },
    timestamp,
  }
}

async function readLegacyBacktestHistory(): Promise<Manifest[]> {
  try {
    const kvPath = path.join(Global.Path.state, "kv.json")
    const parsed: unknown = JSON.parse(await fs.readFile(kvPath, "utf8"))
    if (!parsed || typeof parsed !== "object" || !("backtest_history" in parsed)) return []
    const raw = parsed.backtest_history
    if (!Array.isArray(raw)) return []
    return raw.map(legacyHistoryToManifest).filter((entry): entry is Manifest => entry !== null)
  } catch {
    return []
  }
}

function manifestFilters(input: Pick<ListInput, "algorithmName" | "algorithmId">): ManifestFilters {
  return {
    algorithmName: input.algorithmName?.trim().toLowerCase() || undefined,
    algorithmId: input.algorithmId?.trim() || undefined,
  }
}

function matchesManifestFilters(entry: Manifest, filters: ManifestFilters): boolean {
  const matchesName = !filters.algorithmName || entry.algorithmName.toLowerCase() === filters.algorithmName
  const matchesId = !filters.algorithmId || entry.algorithmId === filters.algorithmId
  return matchesName && matchesId
}

function addMatchingManifests(byId: Map<string, Manifest>, entries: Manifest[], filters: ManifestFilters): void {
  for (const entry of entries) {
    if (matchesManifestFilters(entry, filters)) byId.set(entry.id, entry)
  }
}

function newestManifests(entries: Manifest[], limit: number): Manifest[] {
  return entries
    .sort((a, b) => (b.timestamp - a.timestamp) || b.id.localeCompare(a.id))
    .slice(0, limit)
}

export function mergeBacktestHistoryEntries(input: {
  durable: Manifest[]
  legacy: Manifest[]
  algorithmName?: string
  algorithmId?: string
  limit: number
}): Manifest[] {
  const filters = manifestFilters(input)
  const byId = new Map<string, Manifest>()
  addMatchingManifests(byId, input.legacy, filters)
  addMatchingManifests(byId, input.durable, filters)
  return newestManifests([...byId.values()], input.limit)
}

async function copyIfReadable(src: string | undefined, dst: string): Promise<string | null> {
  if (!src) return null
  try {
    await fs.copyFile(src, dst)
    return path.basename(dst)
  } catch {
    return null
  }
}

async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Manifest
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.id !== "string" || typeof parsed.algorithmName !== "string") return null
    parsed.dir = path.dirname(file)
    return parsed
  } catch {
    return null
  }
}

export async function save(input: SaveInput): Promise<{ dir: string; manifest: Manifest }> {
  const algorithmDir = safeSegment(input.record.algorithmName)
  const dir = path.join(ROOT, algorithmDir, input.record.id)
  await fs.mkdir(dir, { recursive: true })

  const equityCurve =
    (await copyIfReadable(input.artifacts?.equityCsv, path.join(dir, "equity.csv"))) ??
    input.record.artifacts?.equityCurve ??
    null
  const trades =
    (await copyIfReadable(input.artifacts?.tradesCsv, path.join(dir, "trades.csv"))) ??
    input.record.artifacts?.trades ??
    null
  const dataSnapshot =
    (await copyIfReadable(input.artifacts?.dataSnapshotCsv, path.join(dir, "ohlcv.csv"))) ??
    input.record.artifacts?.dataSnapshot ??
    null
  const processedDataSnapshot = await copyIfReadable(
    input.artifacts?.processedDataSnapshotCsv,
    path.join(dir, "processed_ohlcv.csv"),
  ) ?? input.record.artifacts?.processedDataSnapshot ?? null
  const dataQuality =
    (await copyIfReadable(input.artifacts?.dataQualityJson, path.join(dir, "data_quality.json"))) ??
    input.record.artifacts?.dataQuality ??
    null
  const dataProvenance =
    (await copyIfReadable(input.artifacts?.dataProvenanceJson, path.join(dir, "data_provenance.json"))) ??
    input.record.artifacts?.dataProvenance ??
    null

  const manifest: Manifest = {
    ...input.record,
    artifacts: {
      equityCurve,
      trades,
      sourceArtifacts: input.artifacts?.sourceArtifacts ?? input.record.artifacts?.sourceArtifacts ?? null,
      dataSnapshot,
      processedDataSnapshot,
      dataQuality,
      dataProvenance,
    },
  }
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

async function durableManifests(): Promise<Manifest[]> {
  const roots: string[] = []
  try {
    const algoDirs = await fs.readdir(ROOT, { withFileTypes: true })
    for (const entry of algoDirs) {
      if (!entry.isDirectory()) continue
      roots.push(path.join(ROOT, entry.name))
    }
  } catch {
    // Older installs only have kv.json backtest_history; keep falling through
    // so history and monitor tools can still surface those runs.
  }

  const manifests: Manifest[] = []
  for (const algoRoot of roots) {
    let runs: import("fs").Dirent[]
    try {
      runs = await fs.readdir(algoRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue
      const manifest = await readManifest(path.join(algoRoot, run.name, "manifest.json"))
      if (!manifest) continue
      manifests.push(manifest)
    }
  }
  return manifests
}

export async function get(id: string): Promise<Manifest | null> {
  const durable = await durableManifests()
  const found = durable.find((entry) => entry.id === id)
  if (found) return found
  const legacy = await readLegacyBacktestHistory()
  return legacy.find((entry) => entry.id === id) ?? null
}

export async function list(input: ListInput = {}): Promise<Manifest[]> {
  return mergeBacktestHistoryEntries({
    durable: await durableManifests(),
    legacy: await readLegacyBacktestHistory(),
    algorithmName: input.algorithmName,
    algorithmId: input.algorithmId,
    limit: input.limit ?? 10,
  })
}

export * as BacktestStore from "./store"
