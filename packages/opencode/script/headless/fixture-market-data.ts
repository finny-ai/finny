import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const SYMBOL = "SPY"
const INTERVAL = "5m"
const START = "2026-01-09"
const END = "2026-07-08"
const FILE_STEM = "SPY_5m_2026-01-09_2026-07-08"

function sha256(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function deterministicCsv(): string {
  const lines = ["timestamp,open,high,low,close,volume"]
  const start = Date.parse(`${START}T00:00:00.000Z`)
  const end = Date.parse(`${END}T23:55:00.000Z`)
  const step = 5 * 60_000
  let index = 0
  for (let timestamp = start; timestamp <= end; timestamp += step) {
    // A slow downward drift with a deterministic oscillation creates repeated
    // SMA crosses. The fixture is deliberately not profitable after costs;
    // profitability is not a harness success condition.
    const center = 510 - index * 0.00035
    const wave = 2.4 * Math.sin(index / 23) + 0.65 * Math.sin(index / 7)
    const open = center + wave
    const close = open + 0.08 * Math.sin(index / 3)
    const high = Math.max(open, close) + 0.12
    const low = Math.min(open, close) - 0.12
    const volume = 1_000_000 + (index % 97) * 1_000
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
}): Promise<FixtureMarketDataProvider> {
  if (input.harnessMode !== true) throw new Error("fixture market data requires explicit harness mode")
  const allowedRoot = path.resolve(input.allowedRoot)
  const fixtureRoot = path.resolve(input.fixtureRoot)
  await fs.mkdir(fixtureRoot, { recursive: true })
  const csv = deterministicCsv()
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
      const algorithm = url.searchParams.get("algorithm") || "spy-sma-crossover"
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
        schema_version: 1,
        source: "finny-harness-fixture",
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
        actual_start: `${START}T00:00:00.000Z`,
        actual_end: `${END}T23:55:00.000Z`,
        output_path: relativeCsv,
        rows,
        run_id: `fixture-${csvSha256.slice(0, 16)}`,
        ...(requestId ? { request_id: requestId } : {}),
        ...(requestVersion !== undefined ? { request_version: requestVersion } : {}),
        ...(requestContentHash ? { request_content_hash: requestContentHash } : {}),
        coverage: "complete",
        coverage_note: "deterministic continuous 5-minute harness fixture",
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
