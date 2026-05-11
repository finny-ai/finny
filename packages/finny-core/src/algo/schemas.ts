import { z } from "zod"

export const ALGO_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const VERSION_DIR_RE = /^v[1-9][0-9]*$/

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
    schema_version: z.literal(1),
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
    schema_version: z.literal(1),
    version: z.string().regex(VERSION_DIR_RE, "version must be v<N>"),
    ran_at: z.string().datetime({ offset: true }),
    period: BacktestPeriod,
    config: BacktestConfig,
    metrics: BacktestMetrics,
    notes: z.string().optional(),
  })
  .strict()
export type Backtest = z.infer<typeof Backtest>

export const CURRENT_FILE = "CURRENT"
export const MISSION_FILE = "mission.md"
export const DECISIONS_FILE = "decisions.md"
export const PREFS_FILE = "prefs.md"
export const ARCHIVE_DIR = ".archive"
export const STRATEGY_FILE = "strategy.py"
export const BACKTEST_FILE = "backtest.json"
export const NOTES_FILE = "notes.md"

export function parseCurrent(raw: string): string {
  const trimmed = raw.trim()
  if (!VERSION_DIR_RE.test(trimmed)) {
    throw new Error(`CURRENT must contain a version name like "v1", got: ${JSON.stringify(raw)}`)
  }
  return trimmed
}
