import { BrokerRegistry } from "../live/brokers"
import { Log } from "../util/log"

/**
 * Minimal Alpaca REST helpers for cron checks. Reuses the Alpaca credentials
 * already stored via `live/brokers/alpaca.ts`. No persistent connection — every
 * call is a fresh authed HTTPS request, perfect for periodic cron checks.
 *
 * Data API base is fixed at https://data.alpaca.markets regardless of paper vs
 * live trading endpoint (they're separate hosts). Trading endpoint comes from
 * the credentials so paper accounts hit paper-api.alpaca.markets etc.
 */
export namespace AlpacaData {
  const log = Log.create({ service: "cron.alpaca-data" })
  const DATA_BASE = "https://data.alpaca.markets"

  type Creds = { keyId: string; secret: string; endpoint: string }

  async function pickAccount(): Promise<Creds | null> {
    const accounts = await BrokerRegistry.listAccounts("alpaca")
    if (accounts.length === 0) return null
    const creds = await BrokerRegistry.readCredentials(accounts[0]!.providerID)
    if (!creds) return null
    return creds
  }

  function headers(creds: Creds) {
    return {
      "APCA-API-KEY-ID": creds.keyId,
      "APCA-API-SECRET-KEY": creds.secret,
    }
  }

  async function get<T>(url: string, creds: Creds): Promise<T> {
    const res = await fetch(url, { headers: headers(creds), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`alpaca ${res.status} ${res.statusText} ${url} ${text.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  // Common crypto bases — anything in this set without an explicit quote is
  // assumed to be USD-quoted (matches alpacaSpec.resolvePair behaviour).
  const CRYPTO_BASES = new Set([
    "BTC", "ETH", "SOL", "DOGE", "AVAX", "MATIC", "LINK", "DOT", "ADA",
    "XRP", "LTC", "BCH", "UNI", "AAVE", "SUSHI", "SHIB",
  ])

  /** Returns the crypto pair (e.g. "BTC/USD") or null if symbol is equity. */
  function asCryptoPair(symbol: string): string | null {
    const u = symbol.toUpperCase()
    if (u.includes("/")) return u
    if (CRYPTO_BASES.has(u)) return `${u}/USD`
    return null
  }

  /**
   * Latest trade price + intraday percent change vs prior close.
   * Auto-detects equity vs crypto:
   *   equity (AAPL):  /v2/stocks/snapshots?symbols=AAPL
   *   crypto (BTC):   /v1beta3/crypto/us/snapshots?symbols=BTC/USD
   */
  export async function snapshot(symbol: string): Promise<{
    price: number
    prevClose: number
    pctChange: number
  } | null> {
    const creds = await pickAccount()
    if (!creds) {
      log.warn("snapshot.no-account", { symbol })
      return null
    }

    const cryptoPair = asCryptoPair(symbol)
    type SnapshotEntry = {
      latestTrade?: { p?: number }
      latestQuote?: { ap?: number; bp?: number }
      dailyBar?: { c?: number }
      prevDailyBar?: { c?: number }
    }

    let entry: SnapshotEntry | undefined
    if (cryptoPair) {
      const url = `${DATA_BASE}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(cryptoPair)}`
      type Resp = { snapshots?: Record<string, SnapshotEntry> }
      const data = await get<Resp>(url, creds)
      entry = data.snapshots?.[cryptoPair]
    } else {
      const sym = symbol.toUpperCase()
      const url = `${DATA_BASE}/v2/stocks/snapshots?symbols=${encodeURIComponent(sym)}`
      type Resp = Record<string, SnapshotEntry>
      const data = await get<Resp>(url, creds)
      entry = data[sym]
    }

    // Crypto trades are sparse on Alpaca's single-venue US feed — latestTrade
    // can be minutes stale while quotes update every second. Prefer mid-quote
    // for crypto. Equity markets are continuous during hours, so latestTrade
    // is the freshest source there.
    const midQuote =
      entry?.latestQuote?.ap !== undefined && entry?.latestQuote?.bp !== undefined
        ? (entry.latestQuote.ap + entry.latestQuote.bp) / 2
        : undefined
    const price = cryptoPair
      ? (midQuote ?? entry?.latestTrade?.p ?? entry?.dailyBar?.c)
      : (entry?.latestTrade?.p ?? midQuote ?? entry?.dailyBar?.c)
    const prevClose = entry?.prevDailyBar?.c
    if (typeof price !== "number" || typeof prevClose !== "number" || prevClose === 0) {
      return null
    }
    return { price, prevClose, pctChange: ((price - prevClose) / prevClose) * 100 }
  }

  /** Account-level summary: cash, equity, daily PnL %. */
  export async function account(): Promise<{
    cash: number
    equity: number
    lastEquity: number
    dailyPctChange: number
  } | null> {
    const creds = await pickAccount()
    if (!creds) return null
    type Resp = { cash?: string; equity?: string; last_equity?: string }
    const data = await get<Resp>(`${creds.endpoint}/v2/account`, creds)
    const cash = parseFloat(data.cash ?? "")
    const equity = parseFloat(data.equity ?? "")
    const lastEquity = parseFloat(data.last_equity ?? "")
    if (!Number.isFinite(cash) || !Number.isFinite(equity) || !Number.isFinite(lastEquity) || lastEquity === 0) {
      return null
    }
    return { cash, equity, lastEquity, dailyPctChange: ((equity - lastEquity) / lastEquity) * 100 }
  }

  /** Open position quantity for a symbol. Returns 0 if no position. */
  export async function position(symbol: string): Promise<number | null> {
    const creds = await pickAccount()
    if (!creds) return null
    const url = `${creds.endpoint}/v2/positions/${encodeURIComponent(symbol.toUpperCase())}`
    const res = await fetch(url, { headers: headers(creds), signal: AbortSignal.timeout(10_000) })
    if (res.status === 404) return 0
    if (!res.ok) {
      log.warn("position.failed", { symbol, status: res.status })
      return null
    }
    const data = (await res.json()) as { qty?: string }
    const qty = parseFloat(data.qty ?? "")
    return Number.isFinite(qty) ? qty : null
  }
}
