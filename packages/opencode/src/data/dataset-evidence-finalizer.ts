import fs from "node:fs/promises"
import path from "node:path"
import {
  buildDatasetEvidenceV2,
  type BuildDatasetEvidenceV2Input,
  type BuiltDatasetEvidenceManifest,
} from "./dataset-evidence-builder"

export type FinalizeDatasetEvidenceInput = Omit<
  BuildDatasetEvidenceV2Input,
  "csvBytes" | "csvText" | "outputPath"
> & {
  dataRoot: string
  csvPath: string
}

export interface FinalizedDatasetEvidence {
  manifest: BuiltDatasetEvidenceManifest
  manifestPath: string
  csvPath: string
  outputPath: string
  digest: string
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, file)
}

function digest(input: {
  manifest: BuiltDatasetEvidenceManifest
  workspaceSlug: string
  manifestOutputPath: string
}): string {
  const { manifest } = input
  return [
    `requested_algorithm_name: ${manifest.requested_algorithm_name}`,
    `workspace_slug: ${input.workspaceSlug}`,
    `request_id: ${manifest.request_id}`,
    `request_version: ${manifest.request_version}`,
    `request_content_hash: ${manifest.request_content_hash}`,
    `requested_symbol: ${manifest.requested_symbol}`,
    `actual_symbol: ${manifest.actual_symbol}`,
    `requested_interval: ${manifest.requested_interval}`,
    `actual_interval: ${manifest.actual_interval}`,
    `requested_asset_class: ${manifest.requested_asset_class}`,
    `actual_asset_class: ${manifest.actual_asset_class}`,
    `requested_start: ${manifest.requested_start}`,
    `requested_end: ${manifest.requested_end}`,
    `actual_start: ${manifest.actual_start}`,
    `actual_end: ${manifest.actual_end}`,
    `artifact_paths: ${manifest.output_path}, ${input.manifestOutputPath}`,
    `run_id: ${manifest.run_id}`,
    `source: ${manifest.source}`,
    `evidence_id: ${manifest.evidence_id}`,
    `qualification: ${manifest.qualification.status}`,
    `coverage: ${manifest.coverage}; ${manifest.coverage_note}`,
    `quality: rows=${manifest.rows}, duplicates=${manifest.quality.duplicate_count}, gaps=${manifest.timestamps.missing_count}, invalid_ohlc=${manifest.quality.ohlc_violation_count}, zero_volume=${manifest.quality.zero_volume_count}, outliers=${manifest.quality.outlier_count}, partial_provider_coverage=${manifest.coverage === "full" ? "no" : "yes"}`,
    `usable_for_parent: ${manifest.usable_for_parent}`,
    `usable_for_research: ${manifest.usable_for_research}`,
    `strict_backtest_eligible: ${manifest.strict_backtest_eligible}`,
    `analysis_summary_path: ${manifest.analysis_summary_path ?? "not_returned"}`,
    `analysis_regime: ${manifest.analysis_regime ?? "not_returned"}`,
    `analysis_hypotheses: ${manifest.analysis_hypotheses?.join(" | ") ?? "not_returned"}`,
  ].join("\n")
}

export async function finalizeDatasetEvidenceFile(
  input: FinalizeDatasetEvidenceInput,
): Promise<FinalizedDatasetEvidence> {
  if (path.isAbsolute(input.csvPath)) throw new Error("csvPath must be relative to the active data directory")
  if (!input.csvPath.toLowerCase().endsWith(".csv")) throw new Error("csvPath must name a .csv file")
  const dataRoot = await fs.realpath(input.dataRoot)
  const candidate = path.resolve(dataRoot, input.csvPath)
  const csvPath = await fs.realpath(candidate)
  if (!inside(dataRoot, csvPath)) throw new Error("csvPath escapes the active data directory")
  const outputPath = path.relative(dataRoot, csvPath).replaceAll(path.sep, "/")
  const csvBytes = await fs.readFile(csvPath)
  const csvText = csvBytes.toString("utf8")
  const built = buildDatasetEvidenceV2({
    ...input,
    csvBytes,
    csvText,
    outputPath,
  })
  const manifestPath = csvPath.replace(/\.csv$/i, ".manifest.json")
  await atomicWriteJson(manifestPath, built.manifest)
  const manifestOutputPath = path.relative(dataRoot, manifestPath).replaceAll(path.sep, "/")
  return {
    manifest: built.manifest,
    manifestPath,
    csvPath,
    outputPath,
    digest: digest({ manifest: built.manifest, workspaceSlug: input.workspaceSlug, manifestOutputPath }),
  }
}

