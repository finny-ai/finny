import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

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
    for (const [date, dayRows] of grouped) {
      const lines = dayRows
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
      rowsWritten += dayRows.length
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
  // Correct minimal ZIP writer (deflate + CRC32). LEAN reads the first .csv
  // entry via System.IO.Compression, which validates central directory and
  // sizes, so the structure must be byte-exact.
  const raw = Buffer.from(csv, "utf8")
  const data = deflateRawSync(raw)
  const nameBuf = Buffer.from(name, "utf8")
  const crc = crc32(raw)
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0) // local file header signature
  localHeader.writeUInt16LE(20, 4) // version needed
  localHeader.writeUInt16LE(0x0800, 6) // UTF-8 flag
  localHeader.writeUInt16LE(8, 8) // deflate
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(data.length, 18)
  localHeader.writeUInt32LE(raw.length, 22)
  localHeader.writeUInt16LE(nameBuf.length, 26)
  localHeader.writeUInt16LE(0, 28) // extra length

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0) // central directory signature
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed
  central.writeUInt16LE(0x0800, 8) // UTF-8 flag
  central.writeUInt16LE(8, 10) // deflate
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30) // extra length
  central.writeUInt16LE(0, 32) // comment length
  central.writeUInt16LE(0, 34) // disk number start
  central.writeUInt16LE(0, 36) // internal attrs
  central.writeUInt32LE(0, 38) // external attrs
  central.writeUInt32LE(0, 42) // local header offset

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir disk
  eocd.writeUInt16LE(1, 8) // entries on this disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(46 + nameBuf.length, 12) // central dir size
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length
  return Buffer.concat([localHeader, nameBuf, data, central, nameBuf, eocd])
}

let crcTable: Int32Array | undefined
function crc32(buffer: Buffer): number {
  crcTable ??= (() => {
    const table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    return table
  })()
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable![(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export { localParts }
