/**
 * Pure helpers for SEC EDGAR ticker resolution and filing extraction.
 * Used by tests and referenced from the sec_agent prompt contract.
 */

export interface CompanyTickerEntry {
  cik_str: number
  ticker: string
  title: string
}

export type CompanyTickersIndex = Record<string, CompanyTickerEntry>

export interface TickerResolution {
  cik: string
  ticker: string
  companyName: string
  secUrl: string
}

export interface Form4Transaction {
  reportingOwner: string
  reportingOwnerCik?: string
  transactionDate: string
  transactionCode: string
  shares: number
  pricePerShare?: number
  sharesOwnedFollowing?: number
  securityTitle?: string
}

export interface Form4ParseResult {
  issuerCik?: string
  issuerName?: string
  issuerTicker?: string
  transactions: Form4Transaction[]
}

export interface Form13FHolding {
  issuerName: string
  titleOfClass: string
  cusip?: string
  valueUsd: number
  shares: number
}

export interface Form13FParseResult {
  managerName?: string
  managerCik?: string
  reportDate?: string
  holdings: Form13FHolding[]
}

export interface ReportingOwnerMatch {
  name: string
  cik?: string
  score: number
}

export interface SecRequestContext {
  requested_company_or_ticker?: string
  resolved_symbol?: string
  resolved_cik?: string
  requested_person?: string
  requested_institution?: string
  date_start?: string
  date_end?: string
  analysis_intent?: string
}

const ISO_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g

function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0")
}

function textBetween(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  const m = re.exec(xml)
  if (!m) return undefined
  const inner = m[1] ?? ""
  const value = /<value>([\s\S]*?)<\/value>/i.exec(inner)?.[1]
  return (value ?? inner).trim() || undefined
}

function numBetween(xml: string, tag: string): number | undefined {
  const raw = textBetween(xml, tag)
  if (!raw) return undefined
  const n = Number(raw.replace(/,/g, ""))
  return Number.isFinite(n) ? n : undefined
}

function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function nameTokens(input: string): string[] {
  return normalizeName(input)
    .split(" ")
    .filter((t) => t.length > 1)
}

function resolutionFromEntry(entry: CompanyTickerEntry): TickerResolution {
  const cik = padCik(entry.cik_str)
  return {
    cik,
    ticker: entry.ticker.toUpperCase(),
    companyName: entry.title,
    secUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
  }
}

function findTickerEntry(entries: CompanyTickerEntry[], query: string): CompanyTickerEntry | undefined {
  const upper = query.toUpperCase()
  return entries.find((entry) => entry.ticker.toUpperCase() === upper)
}

function titleMatchesQuery(title: string, query: string): boolean {
  const normalizedTitle = normalizeName(title)
  return normalizedTitle === query || normalizedTitle.includes(query) || query.includes(normalizedTitle)
}

function findCompanyEntry(entries: CompanyTickerEntry[], query: string): CompanyTickerEntry | undefined {
  const normalizedQuery = normalizeName(query)
  return entries.find((entry) => titleMatchesQuery(entry.title, normalizedQuery))
}

/** Resolve a ticker symbol or company name to a CIK using SEC company_tickers.json shape. */
export function resolveTickerToCik(
  index: CompanyTickersIndex,
  query: string,
): TickerResolution | undefined {
  const q = query.trim()
  if (!q) return undefined

  const entries = Object.values(index)
  const entry = findTickerEntry(entries, q) ?? findCompanyEntry(entries, q)
  return entry ? resolutionFromEntry(entry) : undefined
}

/** Extract non-derivative Form 4 transactions from SEC ownershipDocument XML. */
export function parseForm4Transactions(xml: string): Form4ParseResult {
  const issuerCik = textBetween(xml, "issuerCik")
  const issuerName = textBetween(xml, "issuerName")
  const issuerTicker = textBetween(xml, "issuerTradingSymbol")
  const reportingOwner = textBetween(xml, "rptOwnerName") ?? "Unknown"
  const reportingOwnerCik = textBetween(xml, "rptOwnerCik")

  const transactions: Form4Transaction[] = []
  const blockRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(xml))) {
    const block = match[1] ?? ""
    const transactionDate = textBetween(block, "transactionDate")
    const transactionCode = textBetween(block, "transactionCode")
    const shares = numBetween(block, "transactionShares")
    if (!transactionDate || !transactionCode || shares === undefined) continue
    transactions.push({
      reportingOwner,
      reportingOwnerCik,
      transactionDate,
      transactionCode,
      shares,
      pricePerShare: numBetween(block, "transactionPricePerShare"),
      sharesOwnedFollowing: numBetween(block, "sharesOwnedFollowingTransaction"),
      securityTitle: textBetween(block, "securityTitle"),
    })
  }

  return { issuerCik, issuerName, issuerTicker, transactions }
}

/** Parse a simplified 13F holdings JSON document (normalized table, not raw XML). */
export function parse13FHoldings(doc: {
  reportCalendarOrQuarter?: string
  filingManager?: { name?: string; cik?: string }
  holdings?: Array<{
    nameOfIssuer?: string
    titleOfClass?: string
    cusip?: string
    value?: number
    shrsOrPrnAmt?: { sshPrnamt?: number; sshPrnamtType?: string }
  }>
}): Form13FParseResult {
  const holdings: Form13FHolding[] = (doc.holdings ?? []).flatMap((row) => {
    const shares = row.shrsOrPrnAmt?.sshPrnamt
    const valueUsd = row.value
    if (!row.nameOfIssuer || shares === undefined || valueUsd === undefined) return []
    const holding: Form13FHolding = {
      issuerName: row.nameOfIssuer,
      titleOfClass: row.titleOfClass ?? "COM",
      valueUsd,
      shares,
    }
    if (row.cusip) holding.cusip = row.cusip
    return [holding]
  })

  return {
    managerName: doc.filingManager?.name,
    managerCik: doc.filingManager?.cik ? padCik(doc.filingManager.cik) : undefined,
    reportDate: doc.reportCalendarOrQuarter,
    holdings,
  }
}

/**
 * Match a free-text person query against reporting-owner names.
 * Returns multiple matches when ambiguous (e.g. common surname).
 */
export function matchReportingOwners(
  owners: Array<{ name: string; cik?: string }>,
  query: string,
): { matches: ReportingOwnerMatch[]; ambiguous: boolean } {
  const tokens = nameTokens(query)
  if (tokens.length === 0) return { matches: [], ambiguous: false }

  const scored = owners
    .map((owner) => {
      const ownerTokens = nameTokens(owner.name)
      const overlap = tokens.filter((t) => ownerTokens.some((ot) => ot.includes(t) || t.includes(ot)))
      const score = overlap.length / Math.max(tokens.length, 1)
      return { name: owner.name, cik: owner.cik, score }
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)

  const topScore = scored[0]?.score ?? 0
  const matches = scored.filter((m) => m.score === topScore && topScore >= 0.5)
  return { matches, ambiguous: matches.length > 1 }
}

export function extractSecDateWindow(prompt: string): { start?: string; end?: string } {
  const dates = [...prompt.matchAll(ISO_DATE_RE)].map((match) => match[0])
  for (let i = 0; i < dates.length - 1; i++) {
    const start = dates[i]
    const end = dates[i + 1]
    if (start && end && start <= end) return { start, end }
  }
  if (dates[0]) return { start: dates[0] }
  return {}
}

const PERSON_RE =
  /\b(?:did|has|have)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:sell|buy|purchase|trade|dump|acquire)/i
const INSTITUTION_RE =
  /\b(?:holdings?|ownership|13f|institutional)\s+(?:of|for|by)\s+([A-Z][A-Za-z0-9&.\s-]{2,40})/i
const KNOWN_COMPANY_RE = /\b(Microsoft|Apple|NVIDIA|Amazon|Google|Alphabet|Tesla|Meta)\b/i
const FOR_COMPANY_RE = /\bfor\s+([A-Za-z0-9&.\s-]{2,40}?)(?:\?|\.|,|$)/i

function requestedCompanyOrTicker(prompt: string): string | undefined {
  const ticker = /\b([A-Z]{1,5})\b/.exec(prompt)?.[1]
  const company = KNOWN_COMPANY_RE.exec(prompt)?.[1] ?? FOR_COMPANY_RE.exec(prompt)?.[1]?.trim()
  return ticker ?? company
}

/** Best-effort parse of SEC analysis scope from a task prompt. */
export function parseSecRequestContext(prompt: string): SecRequestContext {
  const window = extractSecDateWindow(prompt)
  const person = PERSON_RE.exec(prompt)?.[1]?.trim()
  const institution = INSTITUTION_RE.exec(prompt)?.[1]?.trim()
  const intent = prompt.trim()

  return {
    requested_company_or_ticker: requestedCompanyOrTicker(prompt),
    requested_person: person,
    requested_institution: institution,
    date_start: window.start,
    date_end: window.end,
    analysis_intent: intent.length > 0 ? intent : undefined,
  }
}

export function enrichSecRequestContext(
  context: SecRequestContext,
  index: CompanyTickersIndex,
): SecRequestContext {
  if (!context.requested_company_or_ticker) return context
  const resolved = resolveTickerToCik(index, context.requested_company_or_ticker)
  if (!resolved) return context
  return {
    ...context,
    resolved_symbol: resolved.ticker,
    resolved_cik: resolved.cik,
  }
}

export function secEdgarSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`
}

export function secFilingArchiveUrl(cik: string, accession: string, filename: string): string {
  const accessionNoDash = accession.replace(/-/g, "")
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDash}/${filename}`
}
