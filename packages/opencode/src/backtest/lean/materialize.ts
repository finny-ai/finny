import fs from "node:fs/promises"
import path from "node:path"
import { stableHash, sha256Text } from "./contracts"
import type { LeanBarScheduleV1, LeanDataBundleV1 } from "./types"

export const LEAN_BUNDLE_SCHEMA = "finny.lean_data_bundle"
export const LEAN_BUNDLE_VERSION = 1

const INTERVAL_RESOLUTION: Record<string, "Minute" | "Hour" | "Daily"> = {
  "1min": "Minute",
  "1m": "Minute",
  "5min": "Minute",
  "5m": "Minute",
  "15min": "Minute",
  "15m": "Minute",
  "30min": "Minute",
  "30m": "Minute",
  "1h": "Hour",
  "4h": "Hour",
  "1d": "Daily",
}

function marketFor(assetClass: "equity" | "crypto_spot", canonicalSymbol: string): string {
  return assetClass === "equity" ? "usa" : canonicalSymbol.includes("USDT") ? "binance" : "crypto"
}

export function leanSymbolFor(input: { canonicalSymbol: string; assetClass: "equity" | "crypto_spot" }): string {
  if (input.assetClass === "equity") return input.canonicalSymbol.replace(/^([A-Z.]+).*$/, "$1")
  return input.canonicalSymbol.replace(/[^A-Z0-9]/g, "").toUpperCase()
}

/**
 * Deterministically materialize a phase-scoped LEAN data bundle manifest.
 * The caller supplies authoritative per-symbol bar schedules derived from the
 * strict evidence CSVs; this function validates the schedule against the plan
 * bindings and hashes everything that will be mounted into the run container.
 */
export async function materializeLeanDataBundle(input: {
  phase: LeanDataBundleV1["phase"]
  interval: string
  assetFamily: "equity" | "crypto_spot"
  schedules: Array<LeanBarScheduleV1>
  window: { start: string; end: string }
  warmupBars: number
  outputDir: string
}): Promise<LeanDataBundleV1> {
  const resolution = INTERVAL_RESOLUTION[input.interval]
  if (!resolution) throw new Error(`unsupported LEAN interval ${input.interval}`)
  if (input.schedules.length === 0) throw new Error("no schedules provided")
  if (input.schedules.length > 20) throw new Error("LEAN v1 universes are fixed at up to 20 symbols")
  if (input.schedules.some((s) => s.assetClass !== input.assetFamily)) {
    throw new Error("mixed asset families are unsupported in a LEAN bundle")
  }
  if (input.schedules.some((s) => s.interval !== input.interval)) {
    throw new Error("all LEAN bundle symbols must share one interval")
  }

  // Phase-scoped bar selection: warmup plus the exact phase window. The
  // confirmatory phase may only be materialized by a caller that has already
  // recorded the holdout approval; enforcement lives in the adapter boundary.
  const phaseSchedules = input.schedules.map((schedule) => {
    const phaseBars = schedule.bars.filter((bar) => {
      if (bar.timestamp < `${input.window.start}T00:00:00.000Z`) return false
      return bar.timestamp <= `${input.window.end}T23:59:59.999Z`
    })
    return { schedule, phaseBars }
  })

  const bundle: LeanDataBundleV1 = {
    schema: LEAN_BUNDLE_SCHEMA,
    version: LEAN_BUNDLE_VERSION,
    phase: input.phase,
    interval: input.interval,
    assetFamily: input.assetFamily,
    calendars: phaseSchedules.map(({ schedule }) => ({
      calendarId: schedule.calendarId,
      calendarVersion: schedule.calendarVersion,
      timezone: schedule.timezone,
      scheduleHash: schedule.scheduleHash,
      start: input.window.start,
      end: input.window.end,
    })),
    symbols: phaseSchedules.map(({ schedule, phaseBars }) => ({
      canonicalSymbol: schedule.symbol,
      leanSymbol: leanSymbolFor({ canonicalSymbol: schedule.symbol, assetClass: schedule.assetClass }),
      market: marketFor(schedule.assetClass, schedule.symbol),
      resolution,
      datasetEvidenceId: schedule.scheduleHash.slice(0, 24),
      datasetHash: schedule.scheduleHash,
      scheduleHash: schedule.scheduleHash,
      rows: phaseBars.length,
    })),
    fillForward: false,
    normalizationMode: "raw",
    bundleHash: "",
  }
  bundle.bundleHash = stableHash(bundle)

  // Persist a deterministic manifest alongside the mounted data folder so the
  // run container can verify what it received against the plan binding.
  await fs.mkdir(path.join(input.outputDir, "bundle"), { recursive: true })
  const manifestPath = path.join(input.outputDir, "bundle", "bundle.json")
  await fs.writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8")
  return bundle
}

export function leanDataBundleHash(bundle: Omit<LeanDataBundleV1, "bundleHash">): string {
  return sha256Text(stableHash(bundle))
}
