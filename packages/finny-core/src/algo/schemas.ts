import { z } from "zod"
import { randomUUID } from "node:crypto"

/** Matches a human-readable kebab-case algo name: `btc-mean-reversion-1h` */
export const ALGO_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Slug suffix formats:
 *  - datetime + shortid (current): `D.M.HH.mm.hex8`, e.g. `10.6.11.09.a3f8c9e2`
 *  - datetime (legacy): `D.M.HH.mm` workspace creation time, e.g. `10.6.11.09`
 *  - hex shortid (legacy): 8 lowercase hex chars, e.g. `a3f8c9e2` — still
 *    accepted so existing on-disk workspaces keep resolving.
 */
const DATETIME_SUFFIX_RE_SRC = "\\d{1,2}\\.\\d{1,2}\\.\\d{2}\\.\\d{2}"
const SHORT_ID_RE_SRC = "[a-f0-9]{8}"
const SLUG_SUFFIX_RE_SRC = `(?:${SHORT_ID_RE_SRC}|${DATETIME_SUFFIX_RE_SRC}(?:\\.${SHORT_ID_RE_SRC})?)`

/** Matches a slug (name + suffix): `spy-15m-mean-reversion.10.6.11.09.a3f8c9e2` */
export const ALGO_SLUG_RE = new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*\\.${SLUG_SUFFIX_RE_SRC}$`)

/** Returns true if the string matches the `name.suffix` slug format. */
export function isSlug(s: string): boolean {
  return ALGO_SLUG_RE.test(s)
}

/** Returns true if the string is a valid algo identifier (name or slug). */
export function isValidAlgoId(s: string): boolean {
  return ALGO_NAME_RE.test(s) || ALGO_SLUG_RE.test(s)
}

/** Render the datetime slug suffix `D.M.HH.mm` for a given moment. */
export function slugTimestamp(now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0")
  const mm = String(now.getMinutes()).padStart(2, "0")
  return `${now.getDate()}.${now.getMonth() + 1}.${hh}.${mm}`
}

/** Create a slug from a human name + optional suffix. Defaults to date-time plus a unique short id. */
export function makeSlug(humanName: string, shortId?: string): string {
  if (!ALGO_NAME_RE.test(humanName)) {
    throw new Error(`invalid algo name: ${JSON.stringify(humanName)} (must be kebab-case)`)
  }
  if (shortId !== undefined && !new RegExp(`^${SLUG_SUFFIX_RE_SRC}$`).test(shortId)) {
    throw new Error(
      `invalid slug suffix: ${JSON.stringify(shortId)} (must be D.M.HH.mm.hex8, D.M.HH.mm, or 8 lowercase hex chars)`,
    )
  }
  const id = shortId ?? `${slugTimestamp()}.${randomUUID().replace(/-/g, "").slice(0, 8)}`
  return `${humanName}.${id}`
}

/** Split a slug into its human name and suffix. Names are kebab-case (no dots), so the first dot delimits. */
export function parseSlug(slug: string): { humanName: string; shortId: string } {
  const dot = slug.indexOf(".")
  if (dot === -1) throw new Error(`not a slug: ${JSON.stringify(slug)}`)
  return { humanName: slug.slice(0, dot), shortId: slug.slice(dot + 1) }
}

/** Extract the human-readable name from either a slug or a plain name. */
export function humanNameOf(nameOrSlug: string): string {
  return isSlug(nameOrSlug) ? parseSlug(nameOrSlug).humanName : nameOrSlug
}

// Zero-padded two digits: v01..v99 (no v00).
export const VERSION_DIR_RE = /^v(?:0[1-9]|[1-9][0-9])$/

export const AlgoStatus = z.enum(["research", "backtested", "paper", "live", "retired"])
export type AlgoStatus = z.infer<typeof AlgoStatus>

export const AssetClass = z.enum(["equities", "crypto", "futures", "fx", "options", "mixed"])
export const Horizon = z.enum(["intraday", "days", "weeks", "months"])

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date")

export const MissionScope = z.object({
  asset_class: AssetClass,
  universe: z.array(z.string().min(1)).min(1),
  horizon: Horizon,
})
export type MissionScope = z.infer<typeof MissionScope>

export const MissionFrontmatter = z
  .object({
    schema_version: z.literal(2),
    name: z.string().regex(ALGO_NAME_RE, "name must be kebab-case (lowercase, digits, hyphens)"),
    status: AlgoStatus,
    created: IsoDate,
    hypothesis: z.string().min(1),
    scope: MissionScope,
    exit_conditions: z.string().min(1),
  })
  .strict()
export type MissionFrontmatter = z.infer<typeof MissionFrontmatter>

const Nullable = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.null()])

export const BacktestMetrics = z
  .object({
    total_return: Nullable(z.number()),
    ann_sharpe: Nullable(z.number()),
    annualized_volatility: Nullable(z.number()),
    max_drawdown: Nullable(z.number()),
    win_rate: Nullable(z.number()),
    profit_factor: Nullable(z.number()),
    ending_equity: Nullable(z.number()),
    total_trades: Nullable(z.number().int().nonnegative()),
  })
  .strict()
export type BacktestMetrics = z.infer<typeof BacktestMetrics>

export const BacktestPeriod = z
  .object({
    start: IsoDate,
    end: IsoDate,
    interval: z.string().min(1),
    bars: z.number().int().nonnegative(),
  })
  .strict()

export const BacktestConfig = z
  .object({
    starting_cash: z.number().positive(),
    symbols: z.array(z.string().min(1)).min(1),
  })
  .passthrough()

const BacktestCommon = {
  version: z.string().regex(VERSION_DIR_RE, "version must be v01..v99"),
  ran_at: z.string().datetime({ offset: true }),
  period: BacktestPeriod,
  config: BacktestConfig,
  metrics: BacktestMetrics,
  notes: z.string().optional(),
} as const

export const Backtest = z.discriminatedUnion("schema_version", [
  z.object({
    schema_version: z.literal(2),
    ...BacktestCommon,
  }).strict(),
  z.object({
    schema_version: z.literal(3),
    ...BacktestCommon,
    engine_version: z.string(),
  }).strict(),
])
export type Backtest = z.infer<typeof Backtest>

export const CURRENT_FILE = "CURRENT"
export const MISSION_FILE = "mission.md"
export const DECISIONS_FILE = "decisions.md"
export const MEMORY_FILE = "memory.md"
export const PREFS_FILE = "prefs.md"
export const ARCHIVE_DIR = ".archive"
export const STRATEGY_FILE = "strategy.py"
export const BACKTEST_FILE = "backtest.json"
export const REASONING_FILE = "reasoning.md"
export const PROGRESS_FILE = "progress.md"

/** Hidden per-algo scratch dir for compaction-handoff artifacts (subagent summaries). */
export const FINNY_DIR = ".finny"

export const DATA_DIR = "data"
export const DATA_STOCK_DIR = "data/stock"
export const DATA_ETF_DIR = "data/etf"
export const DATA_FUTURE_DIR = "data/future"
export const DATA_OPTION_DIR = "data/option"
export const DATA_CRYPTO_DIR = "data/crypto"
export const DATA_SEC_DIR = "data/sec"
export const DATA_NEWS_DIR = "data/news"
export const DATA_SENTIMENT_DIR = "data/sentiment"

export const DATA_SUBDIRS = [
  DATA_STOCK_DIR,
  DATA_ETF_DIR,
  DATA_FUTURE_DIR,
  DATA_OPTION_DIR,
  DATA_CRYPTO_DIR,
  DATA_SEC_DIR,
  DATA_NEWS_DIR,
  DATA_SENTIMENT_DIR,
] as const

export const NEWS_HEADLINES_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export function parseCurrent(raw: string): string {
  const trimmed = raw.trim()
  if (!VERSION_DIR_RE.test(trimmed)) {
    throw new Error(`CURRENT must contain a zero-padded version name like "v01", got: ${JSON.stringify(raw)}`)
  }
  return trimmed
}
