import crypto from "node:crypto"
import path from "node:path"
import type { Algorithm } from "@/algorithm"
import type { ControllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import { Mission } from "@/algorithm/mission"
import { readJson, sha256Text, stableStringify, strictRunDir } from "@/backtest/run-integrity-core"
import { verifyPromotion } from "@/backtest/run-integrity"
import { McpRobinhood } from "@/mcp/robinhood"
import {
  EXECUTION_POLICY_SCHEMA,
  accountScopeHash,
  createLiveActivationReceipt,
  type ExecutionBindingV1,
  type ExecutionPolicyV1,
  type LiveActivationReceiptV1,
} from "./execution-risk-gateway"

export type ExecutionMode = "shadow" | "paper" | "live"

export interface PreflightCheck {
  code: string
  status: "pass" | "fail"
  message: string
}

export interface PreflightInput {
  algorithm: Algorithm.Info
  runId: string
  symbol: string
  interval: string
  executionMode: ExecutionMode
  accountProviderID?: string
  controllerApproval?: ControllerPaperApproval
}

export interface PreflightResult {
  schema: "finny.robinhood_live_preflight"
  version: 1
  eligible: boolean
  executionMode: ExecutionMode
  brokerKind: "robinhood"
  paperSupported: false
  checks: PreflightCheck[]
  account?: {
    accountProviderID: string
    label?: string
    accountRole: "agentic"
    accountScopeHash: string
    cash: number
    equity: number
    observedAt: string
    fractionalEquities: boolean
  }
  positions: Array<{ symbol: string; qty: number; mark: number; marketValue: number }>
  openOrders: Array<{
    orderId: string
    intentId?: string
    symbol: string
    side: "buy" | "sell"
    qty: number
    status: string
  }>
  risk?: {
    maxPositions: number
    drawdownLimitPct: number
    sizingStopDistancePct: number
    protectiveStopMode: string
    maxGrossExposurePct?: number
    maxNetExposurePct?: number
    maxSymbolExposurePct?: number
    flattenOnStop?: boolean
  }
  challengeId?: string
  expiresAt?: string
}

export interface PreparedExecution {
  binding: ExecutionBindingV1
  policy: ExecutionPolicyV1
  adapter: McpRobinhood.ExecutionAdapter
  accountProviderID: string
  accountLabel?: string
  fractionalEquities: boolean
  activationReceipt?: LiveActivationReceiptV1
}

interface Challenge extends Omit<PreparedExecution, "activationReceipt"> {
  id: string
  executionMode: "shadow" | "live"
  expiresAt: number
}

const challenges = new Map<string, Challenge>()
const CHALLENGE_TTL_MS = 90_000
const PROCESS_ACTIVATION_SECRET = crypto.randomBytes(32).toString("hex")

function purgeExpired(now: number) {
  for (const [id, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(id)
}

function executionLimits(value: unknown): ExecutionPolicyV1["limits"] | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  const positive = (key: string) => typeof input[key] === "number" && Number.isFinite(input[key]) && input[key] > 0
  if (
    !positive("maxGrossExposurePct") ||
    !positive("maxNetExposurePct") ||
    !positive("maxSymbolExposurePct") ||
    !positive("maxAccountSnapshotAgeMs") ||
    !positive("maxMarketDataAgeMs") ||
    typeof input.flattenOnStop !== "boolean"
  ) {
    return
  }
  return input as unknown as NonNullable<ExecutionPolicyV1["limits"]>
}

export function unsupportedRiskCheck(limits: Pick<NonNullable<ExecutionPolicyV1["limits"]>, "flattenOnStop">) {
  if (!limits.flattenOnStop) return
  return {
    code: "flatten_on_stop_unsupported",
    status: "fail",
    message: "Robinhood flatten-on-stop remains disabled until the official liquidation order flow is schema-reviewed.",
  } satisfies PreflightCheck
}

function failure(
  input: PreflightInput,
  checks: PreflightCheck[],
  partial: Partial<PreflightResult> = {},
): PreflightResult {
  return {
    schema: "finny.robinhood_live_preflight",
    version: 1,
    eligible: false,
    executionMode: input.executionMode,
    brokerKind: "robinhood",
    paperSupported: false,
    checks,
    positions: [],
    openOrders: [],
    ...partial,
  }
}

export async function preflight(
  input: PreflightInput,
  options: {
    access?: McpRobinhood.BrokerAccess
    mapping?: McpRobinhood.ExecutionSchemaMappingV1
    now?: Date
  },
): Promise<PreflightResult> {
  purgeExpired((options.now ?? new Date()).getTime())
  const checks: PreflightCheck[] = []
  const pass = (code: string, message: string) => checks.push({ code, status: "pass", message })
  const fail = (code: string, message: string) => checks.push({ code, status: "fail", message })
  if (input.executionMode === "paper") {
    fail("robinhood_paper_unsupported", "Robinhood has no paper-trading execution mode.")
    return failure(input, checks)
  }
  if (!/^[A-Z]{1,5}$/.test(input.symbol.trim().toUpperCase())) {
    fail(
      "unsupported_asset",
      "Robinhood v1 supports US equities and ETFs only; options, crypto, and shorts are excluded.",
    )
    return failure(input, checks)
  }
  const symbol = input.symbol.trim().toUpperCase()
  pass("asset_scope", "Symbol is within the Robinhood equities/ETF v1 scope.")
  if (!options.access) {
    fail("official_mcp_disconnected", "Connect the official Robinhood Trading MCP before preflight.")
    return failure(input, checks)
  }
  let adapter: McpRobinhood.ExecutionAdapter
  try {
    adapter = McpRobinhood.executionAdapter(options.access, options.mapping)
    pass("official_tool_schema", "Authenticated Robinhood tool schemas match the reviewed execution mapping.")
  } catch (error) {
    fail("official_tool_schema_unavailable", error instanceof Error ? error.message : String(error))
    return failure(input, checks)
  }
  let allAccounts: readonly McpRobinhood.AgenticAccount[]
  try {
    allAccounts = await adapter.accounts()
  } catch {
    fail("account_discovery_failed", "The official Robinhood MCP could not return a safe account list.")
    return failure(input, checks)
  }
  const agentic = allAccounts.filter((account) => account.agentic)
  const selected = input.accountProviderID
    ? agentic.find((account) => account.id === input.accountProviderID)
    : agentic.length === 1
      ? agentic[0]
      : undefined
  if (!selected) {
    fail(
      "agentic_account_required",
      input.accountProviderID
        ? "The selected account is not the dedicated Agentic account."
        : `Expected exactly one dedicated Agentic account; found ${agentic.length}.`,
    )
    return failure(input, checks)
  }
  pass("agentic_account", "The exact dedicated Agentic account was selected.")
  let tradability: { tradable: boolean; assetType: string }
  try {
    tradability = await adapter.tradability(selected.id, symbol)
  } catch {
    fail("tradability_failed", "The official Robinhood MCP could not verify equity/ETF tradability.")
    return failure(input, checks)
  }
  if (!tradability.tradable) {
    fail("symbol_not_tradable", `${symbol} is not tradable in the dedicated Agentic account.`)
    return failure(input, checks)
  }
  pass("symbol_tradable", `${symbol} is tradable as an equity or ETF.`)

  // Live activation builds on the existing exact human-approved strict-run
  // gate. There is no separate live_eligible producer to bypass or simulate.
  const promotionMode = "paper" as const
  const promotion = await verifyPromotion({
    algorithm: input.algorithm,
    runId: input.runId,
    symbol,
    mode: promotionMode,
    controllerApproval: input.controllerApproval,
  }).catch(() => undefined)
  if (!promotion?.ok || !promotion.run || promotion.status !== "paper_eligible") {
    fail(
      "promotion_ineligible",
      promotion?.errors.join("; ") || `Run is ${promotion?.status ?? "not eligible or could not be verified"}.`,
    )
    return failure(input, checks)
  }
  pass("immutable_run", `Verified immutable ${promotion.status} run identity.`)
  const effectiveConfig = await readJson<Record<string, unknown>>({
    file: path.join(strictRunDir(input.algorithm, input.runId), "effective_config.json"),
  }).catch(() => undefined)
  if (!effectiveConfig) {
    fail("risk_policy_incomplete", "The verified run's immutable effective configuration is unavailable.")
    return failure(input, checks)
  }
  const risk = Mission.RiskContractSchema.safeParse(effectiveConfig.risk_contract)
  const limits = executionLimits(effectiveConfig.execution_limits)
  if (!risk.success || !limits) {
    fail("risk_policy_incomplete", "Live execution requires immutable risk_contract and execution_limits fields.")
    return failure(input, checks)
  }
  const riskBlocker = unsupportedRiskCheck(limits)
  if (riskBlocker) {
    checks.push(riskBlocker)
    return failure(input, checks)
  }
  const policy: ExecutionPolicyV1 = {
    schema: EXECUTION_POLICY_SCHEMA,
    version: 1,
    riskContract: risk.data,
    limits,
    capabilities: {
      marketOrders: true,
      fractionalQty: selected.fractionalEquities,
      cancelAll: true,
      positionSnapshot: true,
    },
  }
  const scopeHash = accountScopeHash({ brokerKind: "robinhood", accountProviderID: selected.id })
  const binding: ExecutionBindingV1 = {
    runId: input.runId,
    runIdentityHash: promotion.run.identityHash,
    algorithmId: input.algorithm.algorithmId,
    algorithmVersion: input.algorithm.version,
    strategyHash: promotion.run.identity.strategyHash,
    riskPolicyHash: promotion.run.identity.riskContractHash,
    executionPolicyHash: sha256Text(stableStringify(policy)),
    effectiveConfigHash: promotion.run.identity.effectiveConfigHash,
    symbol,
    interval: input.interval,
    brokerKind: "robinhood",
    brokerMode: "live",
    accountScopeHash: scopeHash,
  }
  const brokerState = await Promise.all([adapter.snapshot(selected.id), adapter.openOrders(selected.id)]).catch(
    () => undefined,
  )
  if (!brokerState) {
    fail("account_snapshot_failed", "The official Robinhood MCP could not produce a fresh account and order snapshot.")
    return failure(input, checks)
  }
  const [snapshot, openOrders] = brokerState
  pass("account_snapshot", "Captured a fresh official account, position, and open-order snapshot.")
  const id = crypto.randomUUID()
  const now = options.now ?? new Date()
  const expiresAt = now.getTime() + CHALLENGE_TTL_MS
  challenges.set(id, {
    id,
    executionMode: input.executionMode,
    expiresAt,
    binding,
    policy,
    adapter,
    accountProviderID: selected.id,
    accountLabel: selected.label,
    fractionalEquities: selected.fractionalEquities,
  })
  return {
    ...failure(input, checks),
    eligible: true,
    account: {
      accountProviderID: selected.id,
      ...(selected.label ? { label: selected.label } : {}),
      accountRole: "agentic",
      accountScopeHash: scopeHash,
      cash: snapshot.cash,
      equity: snapshot.equity,
      observedAt: snapshot.observedAt,
      fractionalEquities: selected.fractionalEquities,
    },
    positions: Object.entries(snapshot.positions).map(([positionSymbol, position]) => ({
      symbol: positionSymbol,
      qty: position.qty,
      mark: position.mark,
      marketValue: position.qty * position.mark,
    })),
    openOrders: [...openOrders],
    risk: {
      maxPositions: risk.data.max_positions,
      drawdownLimitPct: risk.data.drawdown.limit_pct,
      sizingStopDistancePct: risk.data.sizing_stop_distance_pct,
      protectiveStopMode: risk.data.protective_stop.mode,
      maxGrossExposurePct: limits.maxGrossExposurePct,
      maxNetExposurePct: limits.maxNetExposurePct,
      maxSymbolExposurePct: limits.maxSymbolExposurePct,
      flattenOnStop: limits.flattenOnStop,
    },
    challengeId: id,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export function consumeChallenge(input: {
  challengeId: string | undefined
  executionMode: ExecutionMode
  realMoneyAcknowledgement: boolean | undefined
  algorithmId: string
  runId: string
  symbol: string
  interval: string
  accountProviderID: string
  now?: Date
}): PreparedExecution {
  purgeExpired((input.now ?? new Date()).getTime())
  if (!input.challengeId) throw new Error("Robinhood start requires a preflight challenge.")
  const challenge = challenges.get(input.challengeId)
  challenges.delete(input.challengeId)
  if (!challenge) throw new Error("Robinhood preflight challenge is missing or already consumed.")
  const now = input.now ?? new Date()
  if (challenge.expiresAt <= now.getTime()) throw new Error("Robinhood preflight challenge expired.")
  if (challenge.executionMode !== input.executionMode) throw new Error("Robinhood preflight execution mode mismatch.")
  if (
    challenge.binding.algorithmId !== input.algorithmId ||
    challenge.binding.runId !== input.runId ||
    challenge.binding.symbol !== input.symbol.trim().toUpperCase() ||
    challenge.binding.interval !== input.interval ||
    challenge.accountProviderID !== input.accountProviderID
  ) {
    throw new Error("Robinhood preflight challenge binding mismatch.")
  }
  if (input.executionMode === "live") {
    if (input.realMoneyAcknowledgement !== true)
      throw new Error("Robinhood live start requires explicit real-money acknowledgement.")
    return {
      ...challenge,
      activationReceipt: createLiveActivationReceipt({
        challengeId: challenge.id,
        binding: challenge.binding,
        secret: PROCESS_ACTIVATION_SECRET,
        now,
      }),
    }
  }
  return challenge
}

export function clearChallengesForTests() {
  challenges.clear()
}

export * as RobinhoodExecution from "./robinhood-execution"
