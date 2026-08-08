import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Writes Finny-attested OHLCV into LEAN's on-disk data layout. QuantConnect
 * equity/forex files store prices scaled by 10000 (LEAN divides by 10000 on
 * read via TradeBar._scaleFactor); crypto files store raw prices with
 * epoch-ms timestamps. All timestamps are converted to the exchange-local
 * timezone before writing so LEAN's session alignment matches Finny's
 * evidence calendars.
 */

const EQUITY_SCALE = 10_000
const EQUITY_TZ = "America/New_York"
const CRYPTO_TZ = "UTC"

export interface LeanDataRow {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export function parseFinnyOhlcv(text: string): LeanDataRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const header = lines[0]?.split(",").map((v) => v.trim().toLowerCase()) ?? []
  const index = (name: string) => header.indexOf(name)
  if (index("timestamp") < 0 || index("open") < 0) throw new Error("ohlcv.csv is missing required columns")
  return lines.slice(1).map((line, i) => {
    const cols = line.split(",")
    const parsed = Date.parse(cols[index("timestamp")]!.trim().replace(/^"|"$/g, ""))
    if (!Number.isFinite(parsed)) throw new Error(`ohlcv.csv row ${i + 2} has an invalid timestamp`)
    return {
      timestamp: new Date(parsed).toISOString(),
      open: Number(cols[index("open")]),
      high: Number(cols[index("high")]),
      low: Number(cols[index("low")]),
      close: Number(cols[index("close")]),
      volume: Number(cols[index("volume")] ?? 0),
    }
  })
}

function localParts(input: { timestamp: string; timezone: string }) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(input.timestamp))
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return {
    date: `${values.year}${values.month}${values.day}`,
    time: `${values.hour}:${values.minute}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

function scaled(row: LeanDataRow, scale: number) {
  return {
    open: row.open * scale,
    high: row.high * scale,
    low: row.low * scale,
    close: row.close * scale,
  }
}

/**
 * Write the LEAN data tree for one symbol. `dataDir` is the mounted /Lean/Data
 * root; reference DBs are copied from the bundled data-reference fixture.
 */
export async function writeLeanMarketData(input: {
  rows: LeanDataRow[]
  symbol: string
  assetClass: "equity" | "crypto_spot"
  interval: string
  dataDir: string
}): Promise<{ files: string[]; rowsWritten: number }> {
  const reference = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "lean-engine",
    "data-reference",
  )
  await fs.cp(reference, input.dataDir, { recursive: true })

  const timezone = input.assetClass === "equity" ? EQUITY_TZ : CRYPTO_TZ
  const scale = input.assetClass === "equity" ? EQUITY_SCALE : 1
  const leanSymbol = input.symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase()
  const market = input.assetClass === "equity" ? "usa" : "crypto"
  const resolution = input.interval === "1d" ? "daily" : input.interval === "1h" || input.interval === "4h" ? "hour" : "minute"

  const grouped = new Map<string, LeanDataRow[]>()
  for (const row of input.rows) {
    const local = localParts({ timestamp: row.timestamp, timezone })
    const key = local.date
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  }

  const files: string[] = []
  let rowsWritten = 0

  if (resolution === "minute") {
    const dir = path.join(input.dataDir, input.assetClass === "equity" ? "equity" : "crypto", market, "minute", leanSymbol.toLowerCase())
    await fs.mkdir(dir, { recursive: true })
    for (const [date, rows] of grouped) {
      const lines = rows
        .map((row) => {
          const local = localParts({ timestamp: row.timestamp, timezone })
          const ms = (local.hour * 3600 + local.minute * 60 + local.second) * 1000
          const s = scaled(row, scale)
          return `${ms},${s.open},${s.high},${s.low},${s.close},${row.volume}`
        })
        .join("\n")
      const file = path.join(dir, `${date}_trade.zip`)
      const csv = `${lines}\n`
      // Zip with a single stored entry (LEAN reads the first .csv member).
      const zip = await zipCsv(`${date}_trade.csv`, csv)
      await fs.writeFile(file, zip)
      files.push(file)
      rowsWritten += rows.length
    }
  } else {
    const dir = path.join(input.dataDir, input.assetClass === "equity" ? "equity" : "crypto", market, resolution)
    await fs.mkdir(dir, { recursive: true })
    const lines = input.rows
      .map((row) => {
        const local = localParts({ timestamp: row.timestamp, timezone })
        const s = scaled(row, scale)
        return `${local.date} ${local.time},${s.open},${s.high},${s.low},${s.close},${row.volume}`
      })
      .join("\n")
    const file = path.join(dir, `${leanSymbol.toLowerCase()}.zip`)
    await fs.writeFile(file, await zipCsv(`${leanSymbol.toLowerCase()}.csv`, `${lines}\n`))
    files.push(file)
    rowsWritten = input.rows.length
  }
  return { files, rowsWritten }
}

async function zipCsv(name: string, csv: string): Promise<Buffer> {
  // Minimal ZIP writer: local file header + stored data (no compression).
  const data = Buffer.from(csv, "utf8")
  const nameBuf = Buffer.from(name, "utf8")
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6) // UTF-8 name
  header.writeUInt16LE(0, 8) // stored
  header.writeUInt32LE(0, 10)
  header.writeUInt16LE(0, 14)
  header.writeUInt16LE(0, 16)
  header.writeUInt16LE(nameBuf.length, 18)
  header.writeUInt16LE(data.length, 20)
  header.writeUInt16LE(data.length, 24)
  header.writeUInt32LE(0, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt16LE(0, 16)
  central.writeUInt32LE(0, 18)
  central.writeUInt16LE(nameBuf.length, 22)
  central.writeUInt16LE(0, 24)
  central.writeUInt16LE(0, 26)
  central.writeUInt32LE(0, 28)
  central.writeUInt32LE(0, 32)
  central.writeUInt32LE(0, 36)
  central.writeUInt32LE(0, 40)
  central.writeUInt16LE(0, 44)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + nameBuf.length, 12)
  eocd.writeUInt32LE(30 + nameBuf.length + data.length + 46 + nameBuf.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([header, nameBuf, data, central, nameBuf, eocd])
}

export { localParts }
