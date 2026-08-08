import { z } from "zod"
import { resolveSymbol } from "../data/symbols"
import { Mission } from "./mission"
import { BROKER_KINDS } from "@/live/brokers/types"

// Canonical execution-context parameters extracted from chat. Stored as the
// JSON string in Algorithm.Info.config. Only the inputs the user supplies —
// outputs (returns, P&L) live elsewhere.
export const StrategyParams = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
  symbol: z.string().optional(),
  asset_class: z.enum(["equity", "crypto", "crypto_spot", "crypto_perp", "future", "fx", "option"]).optional(),
  interval: z.enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"]).optional(),
  required_history_bars: z.number().int().nonnegative().optional(),
  equity_usd: z.number().positive().optional(),
  brokerage: z.enum(BROKER_KINDS).optional(),
  runtime: z
    .object({
      profile: z
        .object({
          schema: z.literal("finny.runtime_profile"),
          version: z.literal(1),
          profileId: z.enum(["finny_python", "lean_python", "lean_csharp"]),
          profileHash: z.string().regex(/^[a-f0-9]{64}$/i),
        })
        .optional(),
      source: z
        .object({
          schema: z.literal("finny.strategy_source"),
          version: z.literal(1),
          profileId: z.enum(["lean_python", "lean_csharp"]),
          files: z
            .array(
              z.object({
                path: z.string(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/i),
                bytes: z.number().int().nonnegative(),
              }),
            )
            .min(1),
          sourceTreeHash: z.string().regex(/^[a-f0-9]{64}$/i),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
  execution: z
    .object({
      max_leverage: z.number().positive().optional(),
      initial_margin_pct: z.number().positive().optional(),
      maintenance_margin_pct: z.number().nonnegative().optional(),
      funding_rate_bps: z.number().optional(),
      funding_interval_hours: z.number().positive().optional(),
      spread_enabled: z.boolean().optional(),
      maker_fee_bps: z.number().nonnegative().optional(),
      taker_fee_bps: z.number().nonnegative().optional(),
      commission_per_contract: z.number().nonnegative().optional(),
      slippage_bps: z.number().nonnegative().optional(),
    })
    .passthrough()
    .optional(),
  asset_spec: z.record(z.string(), z.unknown()).optional(),
  backtest: z
    .object({
      duration: z.string().optional(), // "2w", "4w", "5d", "1m", "Ny", …
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    })
    .optional(),
  // Legacy field preserved for compatibility — Build agent has historically
  // emitted risk.starting_equity_usd and downstream code still reads it.
  risk: z
    .object({
      starting_equity_usd: z.number().optional(),
    })
    .optional(),
  // Schema-v4 mission contract. This is platform-owned execution metadata,
  // not a tunable strategy parameter.
  risk_contract: Mission.RiskContractSchema.optional(),
})
export type StrategyParams = z.infer<typeof StrategyParams>

const EXECUTION_KEYS = new Set([
  "symbol",
  "asset_class",
  "interval",
  "required_history_bars",
  "equity_usd",
  "brokerage",
  "runtime",
  "execution",
  "asset_spec",
  "backtest",
  "risk",
  "risk_contract",
])

function parseRawObject(json: string | undefined | null): Record<string, any> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Tolerant parser: bad / missing JSON returns {}. Unknown keys are dropped by
// the schema so this always yields a clean object.
export function parseConfig(json: string | undefined | null): StrategyParams {
  if (!json) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  const result = StrategyParams.safeParse(raw)
  if (!result.success) return {}
  return result.data
}

// Deep-merge a partial patch into an existing params object. `null` clears a
// field; `undefined` leaves it alone. Nested objects merge field-by-field.
export function mergeConfig(prev: StrategyParams, patch: Partial<StrategyParams>): StrategyParams {
  const out: StrategyParams = { ...prev }
  for (const [key, value] of Object.entries(patch) as [keyof StrategyParams, any][]) {
    if (value === undefined) continue
    if (value === null) {
      delete (out as any)[key]
      continue
    }
    if (
      key === "params" ||
      key === "backtest" ||
      key === "risk" ||
      key === "risk_contract" ||
      key === "execution" ||
      key === "asset_spec"
    ) {
      const prevSub = (prev as any)[key] ?? {}
      const merged = { ...prevSub }
      for (const [k2, v2] of Object.entries(value)) {
        if (v2 === undefined) continue
        if (v2 === null) delete (merged as any)[k2]
        else (merged as any)[k2] = v2
      }
      ;(out as any)[key] = merged
      continue
    }
    ;(out as any)[key] = value
  }
  return out
}

export function serializeConfig(p: StrategyParams): string {
  return JSON.stringify(p)
}

/**
 * Normalize agent-supplied config before persistence.
 *
 * Generated strategies historically mixed execution inputs (`symbol`,
 * `interval`, capital) and strategy knobs (`fast_ma`, `stop_loss`) at the top
 * level. The backtest engine needs execution inputs top-level, while strategy
 * code receives knobs through `params`. On version saves, preserve execution
 * inputs from the previous version unless explicitly overridden or cleared.
 */
export function normalizeConfigForSave(input: {
  incoming?: string | null
  previous?: string | null
  preserveExecution?: boolean
}): string | undefined {
  const incoming = parseRawObject(input.incoming)
  const previous = parseRawObject(input.previous)
  const normalized: Record<string, any> = {}

  if (input.preserveExecution) {
    for (const key of EXECUTION_KEYS) {
      if (previous[key] !== undefined) normalized[key] = previous[key]
    }
  }

  const incomingParams = isPlainObject(incoming.params) ? incoming.params : undefined
  const topLevelStrategyParams: Record<string, any> = {}
  let sawIncomingStrategyParams = false

  for (const [key, value] of Object.entries(incoming)) {
    if (key === "params") {
      sawIncomingStrategyParams = true
      continue
    }
    if (EXECUTION_KEYS.has(key)) {
      if (value === null) delete normalized[key]
      else
        normalized[key] =
          key === "symbol" && typeof value === "string" ? (resolveSymbol(value)?.canonical ?? value) : value
      continue
    }
    if (value !== undefined && value !== null) {
      sawIncomingStrategyParams = true
      topLevelStrategyParams[key] = value
    }
  }

  const params =
    sawIncomingStrategyParams || incomingParams
      ? { ...(incomingParams ?? {}), ...topLevelStrategyParams }
      : isPlainObject(previous.params)
        ? previous.params
        : undefined

  if (params && Object.keys(params).length > 0) normalized.params = params

  if (Object.keys(normalized).length === 0) return undefined
  return JSON.stringify(normalized)
}

export function missingRequiredNewSaveConfigFields(config: string | undefined | null): string[] {
  const parsed = parseRawObject(config)
  const missing: string[] = []

  if (typeof parsed.symbol !== "string" || parsed.symbol.trim() === "") missing.push("symbol")
  if (typeof parsed.asset_class !== "string" || parsed.asset_class.trim() === "") missing.push("asset_class")
  if (typeof parsed.interval !== "string" || parsed.interval.trim() === "") missing.push("interval")
  if (!Number.isInteger(parsed.required_history_bars) || parsed.required_history_bars < 0)
    missing.push("required_history_bars")
  if (!isPlainObject(parsed.params) || Object.keys(parsed.params).length === 0) missing.push("params")

  return missing
}

export function unsupportedNewSaveConfigReasons(config: string | undefined | null): string[] {
  const parsed = parseRawObject(config)
  const reasons: string[] = []

  if (
    typeof parsed.symbol === "string" &&
    parsed.symbol
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length > 1
  ) {
    reasons.push(
      "symbol must be one tradable symbol, not a comma-separated portfolio; use finny_portfolio_backtest or save one complete strategy per symbol",
    )
  }

  return reasons
}
