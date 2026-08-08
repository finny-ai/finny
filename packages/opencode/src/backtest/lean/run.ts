import fs from "node:fs/promises"
import path from "node:path"
import { buildLeanLauncherConfig } from "./engine-config"
import type { LeanAdapterV1 } from "./runner"
import type {
  CrucibleResultV1,
  LeanAdapterContextV1,
  LeanAdapterFailureV1,
  LeanAdapterResultV1,
  LeanDataBundleV1,
} from "./types"

export interface LeanPhaseRunOutcome {
  ok: true
  result: CrucibleResultV1
  artifactsDir: string
}

export interface LeanPhaseRunFailure {
  ok: false
  kind: LeanAdapterFailureV1["kind"]
  error: string
}

export type LeanPhaseRunResult = LeanPhaseRunOutcome | LeanPhaseRunFailure

/**
 * Reusable phase executor for all Crucible phases. Materializes the data
 * bundle, launches the pinned offline container through the adapter, writes
 * the canonical artifact set consumed by publishStrictRun, and assembles a
 * canonical CrucibleResultV1. Failures are typed and never fall back.
 */
export async function runLeanPhase(input: {
  adapter: LeanAdapterV1
  context: LeanAdapterContextV1
  dataBundle: LeanDataBundleV1
  canonicalize: (artifacts: LeanAdapterResultV1 & { ok: true }) => CrucibleResultV1
}): Promise<LeanPhaseRunResult> {
  const { adapter, context, dataBundle, canonicalize } = input
  await fs.mkdir(path.join(context.resultsDir, "bundle"), { recursive: true })
  await fs.writeFile(
    path.join(context.resultsDir, "bundle", "bundle.json"),
    `${JSON.stringify(dataBundle, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(
    path.join(context.resultsDir, "bundle", "config.json"),
    buildLeanLauncherConfig({
      profile: context.bundle.executionProfile,
      assetFamily: dataBundle.assetFamily,
      startDate: context.window.start,
      endDate: context.window.end,
      cash: 10000,
      algorithmTypeName: "Main",
      algorithmLanguage: context.bundle.profile.profileId === "lean_csharp" ? "CSharp" : "Python",
      algorithmLocation: context.bundle.profile.profileId === "lean_csharp" ? "Algorithm.dll" : "main.py",
      dataFolder: "/Lean/Data",
      resultsFolder: "/Results",
      seed: context.seed,
      dataFeedWorkers: context.bundle.executionProfile.dataFeedWorkers,
    }).json,
    "utf8",
  )

  const outcome = await adapter.run(context)
  if (!outcome.ok) {
    return { ok: false, kind: outcome.kind, error: outcome.error }
  }
  const result = canonicalize(outcome)

  // Canonical artifact set mirrors STRICT_REQUIRED_ARTIFACTS consumers.
  const writeCsv = async (name: string, rows: unknown[]) => {
    if (rows.length === 0) {
      await fs.writeFile(path.join(context.resultsDir, name), "", "utf8")
      return
    }
    const headers = Object.keys(rows[0] as Record<string, unknown>).join(",")
    const lines = rows.map((row) =>
      Object.values(row as Record<string, unknown>)
        .map((value) => (typeof value === "number" ? String(value) : JSON.stringify(value ?? "")))
        .join(","),
    )
    await fs.writeFile(path.join(context.resultsDir, name), [headers, ...lines].join("\n") + "\n", "utf8")
  }
  await writeCsv("orders.csv", result.orders)
  await writeCsv("fills.csv", result.fills)
  await writeCsv("rejections.csv", result.rejections)
  await writeCsv(
    "equity.csv",
    result.navCurve.map((point) => ({ timestamp: point.timestamp, equity: point.equity })),
  )
  await fs.writeFile(
    path.join(context.resultsDir, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  )
  return { ok: true, result, artifactsDir: context.resultsDir }
}
