import fs from "node:fs/promises"
import path from "node:path"
import { finnyHomeArtifacts } from "@finny-ai/core/prefs"
import type { Algorithm } from "@/algorithm"
import { resolveAlgorithmFolder } from "@/algorithm/folder"
import type { BacktestRunner } from "./runner"
import type { UnifiedVerdict } from "./verdict"
import { sparkline, svgAreaChart, svgBarChart, svgHeatmap, svgLineChart } from "./svg-charts"

type Row = Record<string, string>

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  const headers = lines.shift()?.split(",") ?? []
  return lines.map((line) => {
    const cells = line.split(",")
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]))
  })
}

async function readCsv(file: string): Promise<Row[]> {
  try {
    return parseCsv(await fs.readFile(file, "utf8"))
  } catch {
    return []
  }
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function at(root: unknown, ...path: string[]): any {
  return path.reduce((value, key) => value == null ? undefined : (value as any)[key], root as any)
}

function pct(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "insufficient history"
}

function num(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "insufficient history"
}

function underwater(equity: number[]): number[] {
  let peak = equity[0] ?? 0
  return equity.map((v) => {
    peak = Math.max(peak, v)
    return peak > 0 ? v / peak - 1 : 0
  })
}

type ReviewInput = {
  algorithm: Algorithm.Info
  results: BacktestRunner.Results
  verdict: UnifiedVerdict
  reasons: string[]
}

type ReviewData = ReviewInput & {
  equity: number[]
  benchmark: number[]
  drawdown: number[]
  rollingSharpe: number[]
}

function tradesPerMonth(v2: BacktestRunner.Results["v2"]): number | null {
  const months = at(v2, "alpha_decay", "breakeven", "n_months")
  const trades = at(v2, "alpha_decay", "breakeven", "n_trades")
  return months && trades ? trades / months : null
}

function rollingSharpeBaseline(v2: BacktestRunner.Results["v2"]) {
  const stability = at(v2, "stability")
  return {
    window: at(stability, "rolling_sharpe_window") ?? 90,
    mean: at(stability, "rolling_sharpe_mean"),
    min: at(stability, "rolling_sharpe_min"),
    seriesArtifact: "rolling_sharpe.csv",
  }
}

function foldOosSharpes(v2: BacktestRunner.Results["v2"]): Array<number | null | undefined> {
  const folds = at(v2, "walk_forward", "folds")
  return Array.isArray(folds) ? folds.map((f) => f.oos_sharpe) : []
}

function durabilityBaseline(results: BacktestRunner.Results) {
  const v2 = results.v2
  return {
    sharpe: results.sharpeRatio,
    rollingSharpe: rollingSharpeBaseline(v2),
    foldOosSharpes: foldOosSharpes(v2),
    monthlyReturns: at(v2, "stability", "monthly_returns") ?? {},
    expectancyPerTrade: at(v2, "trade", "expectancy"),
    perTradeCost: at(v2, "alpha_decay", "breakeven", "per_trade_cost"),
    tradesPerMonth: tradesPerMonth(v2),
  }
}

export function buildDurabilityReport(input: {
  algorithm: Algorithm.Info
  results: BacktestRunner.Results
  verdict: UnifiedVerdict
  reasons: string[]
}) {
  const v2 = input.results.v2
  return {
    schema: "finny.durability",
    version: 1,
    runId: input.results.runId,
    algorithmId: input.algorithm.algorithmId,
    algorithmVersion: input.algorithm.version,
    experiment: input.results.experiment ?? null,
    window: {
      start: at(v2, "start_ts"),
      end: at(v2, "end_ts"),
      interval: at(v2, "interval"),
      bars: at(v2, "bars_processed"),
    },
    baseline: durabilityBaseline(input.results),
    consistency: at(v2, "consistency") ?? null,
    decay: at(v2, "alpha_decay") ?? null,
    verdict: input.verdict,
    reasons: input.reasons,
    generatedAt: new Date().toISOString(),
  }
}

export function renderReviewMarkdown(data: {
  algorithm: Algorithm.Info
  results: BacktestRunner.Results
  verdict: UnifiedVerdict
  reasons: string[]
  equity: number[]
  rollingSharpe: number[]
}): string {
  const v2 = data.results.v2
  const consistency = at(v2, "consistency")
  const decay = at(v2, "alpha_decay")
  const breakevenMonths = at(decay, "breakeven", "months")
  const breakevenStatus = at(decay, "breakeven", "status") ?? "insufficient history"
  const breakevenText = breakevenMonths == null ? breakevenStatus : `${breakevenMonths.toFixed(1)} months`
  return [
    `# Backtest Review: ${data.algorithm.name}`,
    ``,
    `Verdict: ${data.verdict}`,
    `Reasons: ${data.reasons.join("; ")}`,
    data.results.experiment
      ? `Experiment: ${data.results.experiment.experimentId} | Trial ${data.results.experiment.trialNumber} | Phase: ${data.results.experiment.phase}`
      : `Experiment: legacy/untracked`,
    ``,
    `## Base Metrics`,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Total return | ${pct(data.results.totalReturn)} |`,
    `| Max drawdown | ${pct(data.results.maxDrawdown)} |`,
    `| Sharpe | ${num(data.results.sharpeRatio)} |`,
    `| Trades | ${data.results.totalTrades} |`,
    ``,
    `## Walk-Forward`,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Folds | ${at(v2, "walk_forward", "n_folds") ?? "insufficient history"} |`,
    `| OOS Sharpe mean | ${num(at(v2, "walk_forward", "oos_sharpe_mean"))} |`,
    `| OOS decay | ${num(at(v2, "walk_forward", "oos_decay"))} |`,
    ``,
    `## Consistency`,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Label | ${at(consistency, "label") ?? "insufficient history"} |`,
    `| Confidence | ${at(consistency, "confidence") ?? "insufficient history"} |`,
    `| Equity R2 | ${num(at(consistency, "equity_curve_r2"), 3)} |`,
    `| Positive periods | ${pct(at(consistency, "pct_positive_periods"))} |`,
    `| Equity sparkline | ${sparkline(data.equity)} |`,
    ``,
    `## Alpha Decay`,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Label | ${at(decay, "label") ?? "insufficient history"} |`,
    `| Confidence | ${at(decay, "confidence") ?? "insufficient history"} |`,
    `| MK trend | ${at(decay, "mann_kendall", "trend") ?? "insufficient history"} |`,
    `| Cost breakeven | ${breakevenText} |`,
    `| Rolling Sharpe | ${sparkline(data.rollingSharpe)} |`,
    ``,
    `Approval: only run finny_paper_approve after human review of this packet.`,
  ].join("\n")
}

export function renderReviewHtml(data: {
  algorithm: Algorithm.Info
  results: BacktestRunner.Results
  verdict: UnifiedVerdict
  reasons: string[]
  equity: number[]
  benchmark: number[]
  drawdown: number[]
  rollingSharpe: number[]
}): string {
  const v2 = data.results.v2
  const foldSharpes = foldOosSharpes(v2).map((value) => value ?? 0)
  const equitySeries = [{ label: "Strategy", values: data.equity, color: "#1f5aa6" }]
  if (data.benchmark.length) equitySeries.push({ label: "Buy and hold", values: data.benchmark, color: "#777" })
  return `<!doctype html><html><head><meta charset="utf-8"><title>Backtest Review</title><style>body{font:14px system-ui, sans-serif;margin:32px;color:#17202a}section{margin:28px 0}h1,h2{margin:0 0 12px}table{border-collapse:collapse}td,th{border-bottom:1px solid #dde2e8;padding:6px 10px;text-align:left}.verdict{font-weight:700}</style></head><body><h1>${data.algorithm.name} Review</h1><p class="verdict">Verdict: ${data.verdict}</p><p>${data.reasons.join("; ")}</p><section><h2>Equity vs Buy and Hold</h2>${svgLineChart(equitySeries)}</section><section><h2>Underwater Drawdown</h2>${svgAreaChart(data.drawdown)}</section><section><h2>Monthly Returns</h2>${svgHeatmap(at(v2, "stability", "monthly_returns") ?? {})}</section><section><h2>Rolling Sharpe</h2>${svgLineChart([{ label: "Rolling Sharpe", values: data.rollingSharpe, color: "#7a3f99" }])}</section><section><h2>Fold OOS Sharpe</h2>${svgBarChart(foldSharpes)}</section></body></html>`
}

async function loadReviewData(input: ReviewInput): Promise<ReviewData> {
  const artifactDir = input.results.artifactDir
  const equityRows = artifactDir ? await readCsv(path.join(artifactDir, "finny_evidence_equity.csv")) : []
  const fallbackRows = artifactDir && equityRows.length === 0 ? await readCsv(path.join(artifactDir, "equity.csv")) : []
  const rows = equityRows.length ? equityRows : fallbackRows
  const rollingRows = artifactDir ? await readCsv(path.join(artifactDir, "rolling_sharpe.csv")) : []
  const equity = rows.map((r) => numberValue(r.strategy_equity ?? r.equity)).filter((v): v is number => v !== undefined)
  const benchmark = rows.map((r) => numberValue(r.benchmark_equity)).filter((v): v is number => v !== undefined)
  const rollingSharpe = rollingRows.map((r) => numberValue(r.rolling_sharpe)).filter((v): v is number => v !== undefined)
  return { ...input, equity, benchmark, drawdown: underwater(equity), rollingSharpe }
}

async function writeDurability(input: ReviewInput): Promise<string | undefined> {
  const artifactDir = input.results.artifactDir
  if (!artifactDir) return undefined
  const durabilityPath = path.join(artifactDir, "durability.json")
  const report = buildDurabilityReport(input)
  try {
    await fs.writeFile(durabilityPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
    const existing = JSON.parse(await fs.readFile(durabilityPath, "utf8"))
    if (
      existing?.schema !== report.schema ||
      existing?.version !== report.version ||
      existing?.runId !== report.runId ||
      existing?.algorithmId !== report.algorithmId ||
      existing?.algorithmVersion !== report.algorithmVersion ||
      existing?.verdict !== report.verdict
    ) {
      throw new Error("immutable durability.json does not match this run")
    }
  }
  if (input.results.evidenceDir) {
    await fs.copyFile(durabilityPath, path.join(input.results.evidenceDir, "durability.json")).catch(() => undefined)
  }
  return durabilityPath
}

async function writeReviewDocs(data: ReviewData): Promise<string | undefined> {
  const artifacts = finnyHomeArtifacts()
  const resolved = await resolveAlgorithmFolder({
    algorithmId: data.algorithm.algorithmId,
    name: data.algorithm.name,
    algosRoot: artifacts.algos,
    algorithmsRoot: artifacts.algorithms,
  })
  if (!resolved.found) return undefined
  await fs.writeFile(path.join(resolved.path, "review.md"), renderReviewMarkdown(data), "utf8")
  await fs.writeFile(path.join(resolved.path, "review.html"), renderReviewHtml(data), "utf8")
  return resolved.path
}

export async function generateReviewPacket(input: ReviewInput): Promise<{ reviewDir?: string; durabilityPath?: string; error?: string }> {
  try {
    const data = await loadReviewData(input)
    const durabilityPath = await writeDurability(input)
    const reviewDir = await writeReviewDocs(data)
    return reviewDir ? { reviewDir, durabilityPath } : { durabilityPath, error: "algorithm folder unresolved; review.md/review.html not written" }
  } catch (error: any) {
    return { error: error?.message ?? String(error) }
  }
}
