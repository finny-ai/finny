export type RegionalBrokerKind = "zerodha" | "saxo" | "questrade" | "futu"

export type RegionalMarket = {
  region: "india" | "europe" | "canada" | "china"
  suffix: string
  venue: string
  currency: string
  timezone: string
  brokerKind: RegionalBrokerKind
  brokerExchange: string
  calendar: "XNSE" | "XBOM" | "XTSE" | "XTSX" | "XEUR" | "XHKG" | "XSHG" | "XSHE"
  tickSize: number
  lotSize: number
}

const MARKETS: readonly RegionalMarket[] = [
  {
    region: "india",
    suffix: ".NS",
    venue: "NSE",
    currency: "INR",
    timezone: "Asia/Kolkata",
    brokerKind: "zerodha",
    brokerExchange: "NSE",
    calendar: "XNSE",
    tickSize: 0.05,
    lotSize: 1,
  },
  {
    region: "india",
    suffix: ".BO",
    venue: "BSE",
    currency: "INR",
    timezone: "Asia/Kolkata",
    brokerKind: "zerodha",
    brokerExchange: "BSE",
    calendar: "XBOM",
    tickSize: 0.05,
    lotSize: 1,
  },
  {
    region: "canada",
    suffix: ".TO",
    venue: "TSX",
    currency: "CAD",
    timezone: "America/Toronto",
    brokerKind: "questrade",
    brokerExchange: "TSX",
    calendar: "XTSE",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "canada",
    suffix: ".V",
    venue: "TSXV",
    currency: "CAD",
    timezone: "America/Toronto",
    brokerKind: "questrade",
    brokerExchange: "TSXV",
    calendar: "XTSX",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".AS",
    venue: "AEX",
    currency: "EUR",
    timezone: "Europe/Amsterdam",
    brokerKind: "saxo",
    brokerExchange: "XAMS",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".BR",
    venue: "EBR",
    currency: "EUR",
    timezone: "Europe/Brussels",
    brokerKind: "saxo",
    brokerExchange: "XBRU",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".DE",
    venue: "XETRA",
    currency: "EUR",
    timezone: "Europe/Berlin",
    brokerKind: "saxo",
    brokerExchange: "XETR",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".L",
    venue: "LSE",
    currency: "GBP",
    timezone: "Europe/London",
    brokerKind: "saxo",
    brokerExchange: "XLON",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".MC",
    venue: "BME",
    currency: "EUR",
    timezone: "Europe/Madrid",
    brokerKind: "saxo",
    brokerExchange: "XMAD",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".MI",
    venue: "BIT",
    currency: "EUR",
    timezone: "Europe/Rome",
    brokerKind: "saxo",
    brokerExchange: "XMIL",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".PA",
    venue: "EPA",
    currency: "EUR",
    timezone: "Europe/Paris",
    brokerKind: "saxo",
    brokerExchange: "XPAR",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "europe",
    suffix: ".SW",
    venue: "SIX",
    currency: "CHF",
    timezone: "Europe/Zurich",
    brokerKind: "saxo",
    brokerExchange: "XSWX",
    calendar: "XEUR",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "china",
    suffix: ".HK",
    venue: "HKEX",
    currency: "HKD",
    timezone: "Asia/Hong_Kong",
    brokerKind: "futu",
    brokerExchange: "HK",
    calendar: "XHKG",
    tickSize: 0.01,
    lotSize: 1,
  },
  {
    region: "china",
    suffix: ".SS",
    venue: "SSE",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    brokerKind: "futu",
    brokerExchange: "SH",
    calendar: "XSHG",
    tickSize: 0.01,
    lotSize: 100,
  },
  {
    region: "china",
    suffix: ".SZ",
    venue: "SZSE",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    brokerKind: "futu",
    brokerExchange: "SZ",
    calendar: "XSHE",
    tickSize: 0.01,
    lotSize: 100,
  },
] as const

const NATIVE_EXCHANGE_TO_SUFFIX = new Map(MARKETS.map((market) => [market.brokerExchange, market.suffix]))
NATIVE_EXCHANGE_TO_SUFFIX.set("NSE", ".NS")
NATIVE_EXCHANGE_TO_SUFFIX.set("BSE", ".BO")
NATIVE_EXCHANGE_TO_SUFFIX.set("TSX", ".TO")
NATIVE_EXCHANGE_TO_SUFFIX.set("TSXV", ".V")
NATIVE_EXCHANGE_TO_SUFFIX.set("SSE", ".SS")
NATIVE_EXCHANGE_TO_SUFFIX.set("SZSE", ".SZ")
NATIVE_EXCHANGE_TO_SUFFIX.set("HKEX", ".HK")

export function regionalMarkets(): readonly RegionalMarket[] {
  return MARKETS
}

/** Convert accepted exchange-qualified input to the exact Yahoo/listing ticker. */
export function normalizeRegionalTicker(input: string): string {
  const upper = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
  const native = /^([A-Z]+):([A-Z0-9.&-]+)$/.exec(upper)
  if (!native) return upper
  const suffix = NATIVE_EXCHANGE_TO_SUFFIX.get(native[1])
  return suffix ? `${native[2]}${suffix}` : upper
}

export function regionalMarketForTicker(input: string): RegionalMarket | null {
  const ticker = normalizeRegionalTicker(input)
  return MARKETS.find((market) => ticker.endsWith(market.suffix)) ?? null
}

export function regionalBaseSymbol(input: string): string | null {
  const ticker = normalizeRegionalTicker(input)
  const market = regionalMarketForTicker(ticker)
  return market ? ticker.slice(0, -market.suffix.length) : null
}

export function regionalNativeSymbol(input: string): string | null {
  const ticker = normalizeRegionalTicker(input)
  const market = regionalMarketForTicker(input)
  const base = regionalBaseSymbol(input)
  if (!market || !base) return null
  if (market.brokerKind === "futu") {
    const providerBase = market.suffix === ".HK" ? base.padStart(5, "0") : base.padStart(6, "0")
    return `${market.brokerExchange}.${providerBase}`
  }
  if (market.brokerKind === "saxo") return `${base}:${market.brokerExchange.toLowerCase()}`
  if (market.brokerKind === "questrade") return ticker
  return `${market.brokerExchange}:${base}`
}

export function isRegionalEquityTicker(input: string): boolean {
  const ticker = normalizeRegionalTicker(input)
  const market = regionalMarketForTicker(ticker)
  if (!market) return false
  const base = ticker.slice(0, -market.suffix.length)
  return /^[A-Z0-9][A-Z0-9.&-]{0,29}$/.test(base)
}
