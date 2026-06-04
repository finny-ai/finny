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

export const CoreQuestionId = z.enum([
  "market_universe",
  "timeframe_bar_interval",
  "strategy_family",
  "directional_thesis_regime",
  "entry_signal_idea",
  "exit_invalidation_rules",
  "risk_tolerance_max_drawdown",
  "backtest_window_success_metric",
])
export type CoreQuestionId = z.infer<typeof CoreQuestionId>

export const CORE_QUESTION_IDS = CoreQuestionId.options

export const MissionQuestion = z
  .object({
    id: CoreQuestionId,
    question: z.string().min(1),
    answer: z.string(),
    status: z.enum(["answered", "skipped"]),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.status === "answered" && item.answer.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "answered questionnaire items must include an answer",
      })
    }
    if (item.status === "skipped" && item.answer !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "skipped questionnaire items must use an empty answer",
      })
    }
  })
export type MissionQuestion = z.infer<typeof MissionQuestion>

export const MissionQuestionnaire = z
  .array(MissionQuestion)
  .length(CORE_QUESTION_IDS.length)
  .superRefine((items, ctx) => {
    const seen = new Map<CoreQuestionId, number>()
    for (const item of items) {
      seen.set(item.id, (seen.get(item.id) ?? 0) + 1)
    }
    for (const id of CORE_QUESTION_IDS) {
      const count = seen.get(id) ?? 0
      if (count === 1) continue
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: count === 0 ? `missing questionnaire item: ${id}` : `duplicate questionnaire item: ${id}`,
      })
    }
  })
export type MissionQuestionnaire = z.infer<typeof MissionQuestionnaire>

export const MissionStrategy = z
  .object({
    bar_interval: z.string(),
    type: z.string(),
    direction: z.string(),
    entry_signal: z.string(),
    risk_profile: z.string(),
    max_drawdown_pct: z.string(),
    backtest_window: z.string(),
    success_metric: z.string(),
  })
  .strict()
export type MissionStrategy = z.infer<typeof MissionStrategy>

function blank(value: string): boolean {
  return value.trim().length === 0
}

export const MissionFrontmatter = z
  .object({
    schema_version: z.literal(3),
    name: z.string().regex(ALGO_NAME_RE, "name must be kebab-case (lowercase, digits, hyphens)"),
    status: AlgoStatus,
    created: IsoDate,
    hypothesis: z.string().min(1),
    scope: MissionScope,
    strategy: MissionStrategy,
    exit_conditions: z.string().min(1),
    questionnaire: MissionQuestionnaire,
  })
  .strict()
  .superRefine((mission, ctx) => {
    const skipped = new Set(
      mission.questionnaire.filter((item) => item.status === "skipped").map((item) => item.id),
    )
    const requireAnswer = (field: keyof MissionStrategy, question: CoreQuestionId) => {
      if (!blank(mission.strategy[field])) return
      if (skipped.has(question)) return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strategy", field],
        message: `blank strategy.${field} requires questionnaire item ${question} to be skipped`,
      })
    }
    requireAnswer("bar_interval", "timeframe_bar_interval")
    requireAnswer("type", "strategy_family")
    requireAnswer("direction", "directional_thesis_regime")
    requireAnswer("entry_signal", "entry_signal_idea")
    requireAnswer("risk_profile", "risk_tolerance_max_drawdown")
    requireAnswer("max_drawdown_pct", "risk_tolerance_max_drawdown")
    requireAnswer("backtest_window", "backtest_window_success_metric")
    requireAnswer("success_metric", "backtest_window_success_metric")
  })
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
