import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { expectedEvidenceTimestamps } from "../../src/data/dataset-evidence-calendar"
import { normalizedCsvSemanticHash } from "../../src/data/dataset-evidence-v2"

const SYMBOL = process.env.FINNY_HARNESS_SYMBOL ?? "SPY"
const INTERVAL = "5m"
const START = "2026-01-09"
const END = "2026-07-08"
const FILE_STEM = `${SYMBOL}_5m_2026-01-09_2026-07-08`

const BASE_PRICE: Record<string, number> = {
  SPY: 510,
  QQQ: 500,
  AAPL: 230,
  NVDA: 170,
  TSLA: 350,
  MSFT: 450,
}

function symbolSeed(symbol: string): number {
  let seed = 7
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) % 100000
  return seed
}

function sha256(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function deterministicCsv(profile: "negative" | "positive_qualification" = "negative"): string {
  const lines = ["timestamp,open,high,low,close,volume"]
  const expected = expectedEvidenceTimestamps({
    calendarId: "XNYS",
    sessionType: "regular",
    interval: INTERVAL,
    requestedStartInclusive: START,
    requestedEndInclusive: END,
  })
  let index = 0
  const seed = symbolSeed(SYMBOL)
  const center = BASE_PRICE[SYMBOL] ?? 200 + (seed % 400)
  for (const timestamp of expected) {
    // The positive profile is stationary and cyclical so buy-and-hold remains
    // flat while a causal crossover can produce repeated synthetic gains.
    // It exists only to exercise the legal qualification state machine.
    const level = profile === "positive_qualification" ? center : center - index * 0.00035
    const wave =
      profile === "positive_qualification"
        ? center * 0.009 * Math.sin((2 * Math.PI * (index + seed)) / 24)
        : center *
          (0.0047 * Math.sin((index + (seed % 17)) / 23) + 0.0013 * Math.sin((index + (seed % 7)) / 7))
    const open = level + wave
    const close = open + center * 0.00016 * Math.sin((index + seed) / 3)
    const high = Math.max(open, close) + center * 0.00024
    const low = Math.min(open, close) - center * 0.00024
    const volume = Math.round(center * 2_000) + ((index + seed) % 97) * 1_000
    lines.push(
      `${new Date(timestamp).toISOString()},${open.toFixed(6)},${high.toFixed(6)},${low.toFixed(6)},${close.toFixed(6)},${volume}`,
    )
    index += 1
  }
  return `${lines.join("\n")}\n`
}

export type FixtureMarketDataProvider = {
  readonly url: string
  readonly csvPath: string
  readonly csvSha256: string
  readonly rows: number
  readonly requests: () => number
  readonly stop: () => Promise<void>
}

function contained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export async function startFixtureMarketDataProvider(input: {
  port: number
  allowedRoot: string
  fixtureRoot: string
  harnessMode: true
  profile?: "negative" | "positive_qualification"
}): Promise<FixtureMarketDataProvider> {
  if (input.harnessMode !== true) throw new Error("fixture market data requires explicit harness mode")
  const allowedRoot = path.resolve(input.allowedRoot)
  const fixtureRoot = path.resolve(input.fixtureRoot)
  await fs.mkdir(fixtureRoot, { recursive: true })
  const csv = deterministicCsv(input.profile)
  const csvPath = path.join(fixtureRoot, `${FILE_STEM}.csv`)
  await fs.writeFile(csvPath, csv, "utf8")
  const csvSha256 = sha256(csv)
  const rows = csv.split("\n").length - 2
  let requestCount = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    async fetch(request) {
      requestCount += 1
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true, provider: "finny-harness-fixture" })
      if (url.pathname === "/v1/ohlcv") {
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "x-content-sha256": csvSha256,
          },
        })
      }
      if (url.pathname !== "/v1/materialize") return new Response("not found\n", { status: 404 })

      const output = url.searchParams.get("output_dir")
      const algorithm = url.searchParams.get("algorithm") || `${SYMBOL.toLowerCase()}-sma-crossover`
      const requestId = url.searchParams.get("request_id") || undefined
      const requestVersionRaw = url.searchParams.get("request_version")
      const requestVersion =
        requestVersionRaw && Number.isInteger(Number(requestVersionRaw)) ? Number(requestVersionRaw) : undefined
      const requestContentHash = url.searchParams.get("request_content_hash") || undefined
      if (!output) return Response.json({ ok: false, error: "output_dir is required" }, { status: 400 })
      const outputDir = path.resolve(output)
      if (!contained(allowedRoot, outputDir)) {
        return Response.json({ ok: false, error: "output_dir is outside isolated FINNY_HOME" }, { status: 403 })
      }

      const stockDir = path.join(outputDir, "stock")
      await fs.mkdir(stockDir, { recursive: true })
      const relativeCsv = `stock/${FILE_STEM}.csv`
      const relativeManifest = `stock/${FILE_STEM}.manifest.json`
      await fs.writeFile(path.join(outputDir, relativeCsv), csv, "utf8")
      const manifest = {
        schema: "finny.dataset_evidence",
        version: 2,
        schema_version: 2,
        evidence_id: `fixture-${csvSha256.slice(0, 16)}`,
        source: "finny-harness-fixture",
        provider: { id: "finny-harness-fixture", feed: "deterministic", venue: "NYSE" },
        instrument: { asset_class: "equity", canonical_symbol: SYMBOL, provider_symbol: SYMBOL },
        calendar: {
          id: "XNYS",
          version: "finny-calendars-2026.1",
          timezone: "America/New_York",
          session_type: "regular",
          half_day_policy: "scheduled_early_close",
        },
        symbols: [SYMBOL],
        interval: INTERVAL,
        requested_symbol: SYMBOL,
        actual_symbol: SYMBOL,
        requested_interval: INTERVAL,
        actual_interval: INTERVAL,
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: algorithm,
        requested_start: START,
        requested_end: END,
        actual_start: csv.split("\n")[1].split(",")[0],
        actual_end: csv.trim().split("\n").at(-1)!.split(",")[0],
        window: {
          requested_start_inclusive: START,
          requested_end_inclusive: END,
          actual_start_inclusive: csv.split("\n")[1].split(",")[0],
          actual_end_inclusive: csv.trim().split("\n").at(-1)!.split(",")[0],
        },
        timestamps: { expected_count: rows, actual_count: rows, missing_count: 0, extra_count: 0, missing_ranges: [] },
        quality: {
          duplicate_count: 0,
          ohlc_violation_count: 0,
          outlier_count: 0,
          zero_volume_count: 0,
          invalid_volume_count: 0,
          incomplete_final_bar_count: 0,
        },
        price_basis: {
          basis: "adjusted",
          split_treatment: "back_adjusted",
          dividend_treatment: "not_in_price",
          corporate_action_status: "resolved",
          events: [],
        },
        hashes: {
          raw_bytes_sha256: csvSha256,
          normalized_semantic_sha256: normalizedCsvSemanticHash(csv),
          processed_bytes_sha256: csvSha256,
          transformation_versions: { fixture_generation: "finny-harness-xnys-1" },
        },
        repair_lineage: null,
        qualification: { status: "strict_qualified", reason_codes: [] },
        output_path: relativeCsv,
        rows,
        run_id: `fixture-${csvSha256.slice(0, 16)}`,
        ...(requestId ? { request_id: requestId } : {}),
        ...(requestVersion !== undefined ? { request_version: requestVersion } : {}),
        ...(requestContentHash ? { request_content_hash: requestContentHash } : {}),
        coverage: "complete",
        coverage_note: "deterministic complete XNYS regular-session 5-minute harness fixture",
        usable_for_parent: "yes",
        csv_sha256: csvSha256,
      }
      await fs.writeFile(path.join(outputDir, relativeManifest), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
      return Response.json({ ok: true, csv: relativeCsv, manifest: relativeManifest, ...manifest })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    csvPath,
    csvSha256,
    rows,
    requests: () => requestCount,
    stop: async () => {
      await server.stop(true)
    },
  }
}

export const FIXTURE_MARKET_IDENTITY = {
  symbol: SYMBOL,
  interval: INTERVAL,
  startDate: START,
  endDate: END,
  fileStem: FILE_STEM,
} as const
