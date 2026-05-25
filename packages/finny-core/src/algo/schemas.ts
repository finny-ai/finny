import { z } from "zod"
import { randomUUID } from "node:crypto"

/** Matches a human-readable kebab-case algo name: `btc-mean-reversion-1h` */
export const ALGO_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Matches a slug (name + 8-char hex id): `btc-mean-reversion-1h.a3f8c9e2` */
export const ALGO_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{8}$/

/** Returns true if the string matches the `name.shortid` slug format. */
export function isSlug(s: string): boolean {
  return ALGO_SLUG_RE.test(s)
}

/** Returns true if the string is a valid algo identifier (name or slug). */
export function isValidAlgoId(s: string): boolean {
  return ALGO_NAME_RE.test(s) || ALGO_SLUG_RE.test(s)
}

/** Create a slug from a human name + optional short id. Generates a random id if omitted. */
export function makeSlug(humanName: string, shortId?: string): string {
  if (!ALGO_NAME_RE.test(humanName)) {
    throw new Error(`invalid algo name: ${JSON.stringify(humanName)} (must be kebab-case)`)
  }
  if (shortId !== undefined && !/^[a-f0-9]{8}$/.test(shortId)) {
    throw new Error(`invalid shortId: ${JSON.stringify(shortId)} (must be 8 lowercase hex chars)`)
  }
  const id = shortId ?? randomUUID().replace(/-/g, "").slice(0, 8)
  return `${humanName}.${id}`
}

/** Split a slug into its human name and short id. */
export function parseSlug(slug: string): { humanName: string; shortId: string } {
  const dot = slug.lastIndexOf(".")
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

export const Backtest = z
  .object({
    // v2 = legacy same-bar execution. v3 = engine.next-open-v1 (fills at next
    // bar's open, no equity clip, no Sharpe cap). Accept both for read
    // compatibility; new writers should emit 3.
    schema_version: z.union([z.literal(2), z.literal(3)]),
    version: z.string().regex(VERSION_DIR_RE, "version must be v01..v99"),
    ran_at: z.string().datetime({ offset: true }),
    period: BacktestPeriod,
    config: BacktestConfig,
    metrics: BacktestMetrics,
    notes: z.string().optional(),
    /** Engine identifier (e.g. "engine.next-open-v1"). Required on v3, absent on v2. */
    engine_version: z.string().optional(),
  })
  .strict()
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

export const DATA_DIR = "data"
export const DATA_STOCK_DIR = "data/stock"
export const DATA_CRYPTO_DIR = "data/crypto"
export const DATA_SEC_DIR = "data/sec"
export const DATA_NEWS_DIR = "data/news"
export const DATA_NEWS_HEADLINES_DIR = "data/news/headlines"
export const DATA_NEWS_BODY_DIR = "data/news/body"

export const DATA_SUBDIRS = [
  DATA_STOCK_DIR,
  DATA_CRYPTO_DIR,
  DATA_SEC_DIR,
  DATA_NEWS_HEADLINES_DIR,
  DATA_NEWS_BODY_DIR,
] as const

export const NEWS_HEADLINES_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export function parseCurrent(raw: string): string {
  const trimmed = raw.trim()
  if (!VERSION_DIR_RE.test(trimmed)) {
    throw new Error(`CURRENT must contain a zero-padded version name like "v01", got: ${JSON.stringify(raw)}`)
  }
  return trimmed
}
