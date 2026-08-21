import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Permission } from "@/permission"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { algoDir, bindSessionWorkspace, getSessionWorkspace, humanNameOf } from "@finny-ai/core/algo"
import * as path from "path"
import {
  assetClassForSymbol,
  normalizeInterval,
  normalizeSymbol,
  parseRequestFacts,
  verifyIdentity,
  workspaceMatchesRequest,
  type RequestFacts,
} from "@/agent/request-identity"
import {
  algorithmNameFromWorkspaceSlug,
  extractDateWindow,
  inferBacktestWindow,
  requestSpecContext,
  syncWorkspaceRequestContext,
  type WorkspaceRequestContext,
} from "@/agent/finny-workspace-context"
import { bindSessionRequest, readRequestSpec } from "@/agent/request-spec"
import { bootstrapWorkspace } from "@/plugin/finny-workspace"
import {
  requireVerifiedDataExtractorEvidenceForSession,
  renderPartialDataExtractorHandoff,
  validateDataExtractorTaskText,
  validateExistingDataExtractorEvidence,
  validateExistingDataExtractorEvidenceSet,
  type PartialDataExtractorEvidence,
} from "@/data/data-extractor-evidence"
import { validateNewsAgentTaskText } from "@/data/news-evidence"
import { parseSecRequestContext } from "@/data/sec-edgar"
import { renderSubagentArtifactPointer } from "@/agent/subagent-artifact"
import { TaskState } from "@/task/state"
import { BuildWorkflow } from "@/task/build-workflow"
import {
  effectiveFundRuntimePermission,
  fundDelegationError,
  isFundRuntimeAgent,
  isFundSpecialistAgent,
} from "@/agent/fund-policy"
import { FundCaseStore } from "@/fund/case-store"
import { StrategyContext } from "@/task/strategy-context"
import {
  activeWorkflowForSession,
  recordVerifiedNewsEvidence,
  recordVerifiedMarketDataSet,
  recordVerifiedSpecialistEvidence,
  recordWorkflowAttempt,
} from "@/algorithm/build-workflow/lifecycle"
import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"

/**
 * Substituted when a subagent's final turn produced no text. Uses the BLOCKED:
 * prefix so parent flows that require subagent evidence never treat silence as
 * a successful result.
 */
export const EMPTY_SUBAGENT_RESULT_MARKER =
  "BLOCKED: subagent returned no usable output (final turn aborted or empty) — do not treat this as evidence."

/** Final text of a subagent run; the BLOCKED marker when there is none. */
export function finalTaskText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  const text = parts.findLast((item) => item.type === "text")?.text?.trim() ?? ""
  return text.length > 0 ? text : EMPTY_SUBAGENT_RESULT_MARKER
}

/**
 * SEC and sentiment workers may finish their durable artifacts and then emit
 * an empty final chat part. A request-scoped artifact pointer is stronger
 * completion evidence than that empty prose, so admit the artifact while
 * retaining the fail-closed marker when no pointer exists.
 */
export function finalSpecialistTaskText(input: {
  subagentType: "sec_agent" | "sentiment_agent"
  text: string
  pointer: string
}) {
  if (!input.pointer) return input.text
  const text =
    input.text === EMPTY_SUBAGENT_RESULT_MARKER
      ? `${input.subagentType} completed with durable request-scoped artifacts.`
      : input.text
  return `${text}\n\n${input.pointer}`
}

export { validateDataExtractorTaskText }

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const permission = "task"
const TASK_START_DESCRIPTION = [
  DESCRIPTION,
  "Launch exactly one optional subagent asynchronously and return immediately.",
  "You will be notified automatically when it finishes.",
  "Pass only these arguments: description, prompt, subagent_type, and optional task_id. Do not pass filePath or any other file argument; read the template before composing the prompt if needed.",
].join("\n\n")
const TASK_RUN_DESCRIPTION = [
  DESCRIPTION,
  "Run exactly one subagent in the foreground and return its result before continuing.",
  "Do not launch evidence agents solely to unlock an exploratory finny_backtest; verified evidence is optional there.",
].join("\n\n")
const TASK_BATCH_RUN_DESCRIPTION = [
  DESCRIPTION,
  "Run two to four independent subagents in parallel and return every result before continuing.",
  "Each task must use a distinct subagent type. Results include BLOCKED results.",
  "Do not launch an evidence batch solely to unlock an exploratory finny_backtest; verified evidence is optional there.",
].join("\n\n")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")
const ACTIVE_BACKGROUND_RESULT_REQUEST =
  /\b(?:status|progress|result|results|output|outputs|completion|complete|completed|finished|done|wait|poll|check)\b/i

function requestsActiveBackgroundResult(params: SingleTaskParameters) {
  return ACTIVE_BACKGROUND_RESULT_REQUEST.test(`${params.description}\n${params.prompt}`)
}

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Session.BusyError ||
    (typeof error === "object" && error !== null && (error as any)._tag === "SessionBusyError")
  )
}

function field(label: string, value: string | undefined) {
  return `- ${label}: ${value ?? "MISSING"}`
}

function requestLineageFields(context?: WorkspaceRequestContext): string[] {
  return [
    field("request_id", context?.request_id),
    field("request_version", context?.request_version === undefined ? undefined : String(context.request_version)),
    field("request_content_hash", context?.request_content_hash),
  ]
}

function explicitlyRequestedDataProvider(prompt: string): string | undefined {
  return /\b(yfinance|binance|alpaca|polygon)\b/i.exec(prompt)?.[1]?.toLowerCase()
}

function dataRequestProvider(prompt: string) {
  return /^\s*-\s*provider\s*:\s*(auto|yfinance|binance|alpaca|polygon)\s*$/im.exec(prompt)?.[1]?.toLowerCase()
}

const DATA_REQUEST_FIELD =
  /^\s*-\s*(?:workspace_slug|request_id|request_version|request_content_hash|requested_algorithm_name|requested_symbol|symbols_or_universe|requested_start|requested_end|requested_interval|requested_asset_class|symbol|start_date|end_date|end_date_inclusive|provider|workspace|allowed_data_dir|mission_path|cookbook_path|asset_class|interval)\s*:/i

function withoutDataRequestBlock(prompt: string) {
  const output: string[] = []
  let inside = false
  for (const line of prompt.split("\n")) {
    if (/^\s*Data request(?: context)?:\s*$/i.test(line)) {
      inside = true
      continue
    }
    if (inside && DATA_REQUEST_FIELD.test(line)) continue
    if (inside && line.trim() === "") {
      inside = false
      continue
    }
    inside = false
    output.push(line)
  }
  return output.join("\n").trim()
}

function isIntradayInterval(interval: string | undefined) {
  return Boolean(interval && /^(\d+)(m|h|min)$/i.test(interval.trim()))
}

const EXTENDED_INTRADAY_WINDOW_DAYS = 120
const EXTENDED_DAILY_WINDOW_DAYS = 730

function isoUtcDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function parseIsoDateDay(input: string | undefined): number | undefined {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return undefined
  const time = Date.parse(`${input}T00:00:00Z`)
  return Number.isFinite(time) ? time : undefined
}

function dateWindowDays(start: string | undefined, end: string | undefined): number | undefined {
  const startTime = parseIsoDateDay(start)
  const endTime = parseIsoDateDay(end)
  if (startTime === undefined || endTime === undefined || endTime < startTime) return undefined
  return Math.ceil((endTime - startTime) / 86_400_000)
}

function previousUtcDate(date: Date) {
  const prev = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  prev.setUTCDate(prev.getUTCDate() - 1)
  return isoUtcDate(prev)
}

export function completedIntradayWindow(input: { start?: string; end?: string; interval?: string; now?: Date }) {
  const now = input.now ?? new Date()
  const today = isoUtcDate(now)
  if (!input.end || input.end !== today || !isIntradayInterval(input.interval)) {
    return { start: input.start, end: input.end, adjusted: false }
  }
  return { start: input.start, end: previousUtcDate(now), adjusted: true }
}

function dataExtractorValidationContext(
  context: WorkspaceRequestContext | undefined,
  promptFacts?: RequestFacts,
): WorkspaceRequestContext | undefined {
  if (!context) return undefined
  const childSymbol = childSymbolWithinContextUniverse(promptFacts?.requested_symbol, context)
  const scoped = childSymbol
    ? {
        ...context,
        requested_symbol: childSymbol,
        requested_symbols: undefined,
      }
    : context
  const window = completedIntradayWindow({
    start: scoped.requested_start,
    end: scoped.requested_end,
    interval: scoped.requested_interval,
  })
  if (!window.adjusted) return scoped
  return {
    ...scoped,
    requested_start: window.start,
    requested_end: window.end,
  }
}

async function readWorkspaceDateWindow(requestID: string): Promise<{
  authoritative: boolean
  requested_start?: string
  requested_end?: string
  requested_interval?: string
}> {
  const spec = await readRequestSpec({ requestID })
  if (!spec) return { authoritative: false }
  return {
    authoritative: true,
    requested_start: spec.requested_start,
    requested_end: spec.requested_end,
    requested_interval: spec.requested_interval,
  }
}

function dataExtractorWindowBlock(input: {
  prompt: string
  workspace: string | null
  existing: {
    authoritative: boolean
    requested_start?: string
    requested_end?: string
    requested_interval?: string
  }
}): string | undefined {
  if (input.existing.requested_start && input.existing.requested_end) return undefined
  if (input.existing.authoritative) {
    return [
      "BLOCKED: incomplete authoritative data window.",
      "The parent RequestSpec must contain both requested_start and requested_end before data_extractor can launch.",
      "Call `finny_workspace_prepare` again with a supported `duration`, or with explicit `startDate` and `endDate`, then relaunch data_extractor.",
      "Do not infer dates only inside the child prompt or edit runtime RequestSpec storage directly.",
      `workspace=${input.workspace ?? "MISSING"}.`,
    ].join(" ")
  }

  const promptWindow = extractDateWindow(input.prompt)
  const days = dateWindowDays(promptWindow.start, promptWindow.end)
  if (days === undefined) return undefined

  const interval = input.existing.requested_interval ?? parseRequestFacts(input.prompt).requested_interval
  const threshold = isIntradayInterval(interval) ? EXTENDED_INTRADAY_WINDOW_DAYS : EXTENDED_DAILY_WINDOW_DAYS
  if (days <= threshold) return undefined

  return [
    "BLOCKED: unapproved extended data window.",
    `The data_extractor prompt requested ${promptWindow.start} to ${promptWindow.end} (${days} days), but the workspace has no user-approved requested_start/requested_end.`,
    "Ask the user with the `question` tool before launching this extraction, explaining why the longer history is needed and offering a shorter default.",
    "After the user approves a window, call `finny_workspace_prepare` with the approved `startDate` and `endDate` before relaunching `data_extractor`.",
    `workspace=${input.workspace ?? "MISSING"}.`,
  ].join(" ")
}

function describeRequestFacts(facts: RequestFacts) {
  const requestedSymbols = facts.requested_symbols?.map((symbol) => normalizeSymbol(symbol)).filter(Boolean)
  const symbol = requestedSymbols?.length
    ? requestedSymbols.join(",")
    : (normalizeSymbol(facts.requested_symbol) ?? "?")
  const interval = normalizeInterval(facts.requested_interval) ?? "?"
  const assetClass =
    facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol ?? requestedSymbols?.[0]) ?? "?"
  return `${symbol} ${interval} ${assetClass}`
}

function workspaceSymbolHintFromSlug(slug: string | null | undefined) {
  if (!slug) return undefined
  const base = slug.split(".")[0] ?? slug
  const parts = base
    .split(/[-_\s.]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const first = parts[0]
  if (!first || !/^[a-z]{1,5}$/i.test(first)) return undefined
  if (!parts.slice(1).some((part) => Boolean(normalizeInterval(part)))) return undefined
  return normalizeSymbol(first)
}

function workspaceMismatchIssues(workspace: string | null, facts: RequestFacts) {
  if (!workspace) return []

  const issues: string[] = []
  const requestedSymbol = normalizeSymbol(facts.requested_symbol)
  const workspaceSymbolHint = workspaceSymbolHintFromSlug(workspace)
  // Only the human-authored base name may encode interval/symbol hints.
  // Timestamp/hash suffixes must not be parsed as request facts — e.g. a slug
  // ending in `6292a27d` would otherwise invent interval `27d` and false-block.
  const workspaceBase = workspace.split(".")[0] ?? workspace
  const workspaceFacts = parseRequestFacts(workspaceBase)
  const requestedInterval = normalizeInterval(facts.requested_interval)
  const workspaceInterval = normalizeInterval(workspaceFacts.requested_interval)

  if ((facts.requested_symbol || facts.requested_symbols?.length) && !workspaceMatchesRequest(workspace, facts)) {
    issues.push(`workspace_slug=${workspace}`)
  }
  if (requestedSymbol && workspaceSymbolHint && requestedSymbol !== workspaceSymbolHint) {
    issues.push(`workspace_symbol=${workspaceSymbolHint}`)
  }
  if (requestedInterval && workspaceInterval && requestedInterval !== workspaceInterval) {
    issues.push(`workspace_interval=${workspaceFacts.requested_interval}`)
  }

  return issues
}

function contextMismatchIssues(context: WorkspaceRequestContext | undefined, facts: RequestFacts) {
  if (!context) return []

  const issues: string[] = []
  const requestedSymbol = normalizeSymbol(facts.requested_symbol)
  const contextSymbol = normalizeSymbol(context.requested_symbol)
  const contextUniverse = context.requested_symbols?.map((symbol) => normalizeSymbol(symbol)).filter(Boolean)
  const requestedInterval = normalizeInterval(facts.requested_interval)
  const contextInterval = normalizeInterval(context.requested_interval)
  const requestedAsset =
    facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol ?? facts.requested_symbols?.[0])

  if (requestedSymbol && contextUniverse?.includes(requestedSymbol)) {
    // In a portfolio request, each child extractor narrows to one symbol in the
    // parent universe while inheriting interval/date constraints below.
  } else if (requestedSymbol && contextSymbol && requestedSymbol !== contextSymbol) {
    issues.push(`context_symbol=${contextSymbol}`)
  }
  if (requestedInterval && contextInterval && requestedInterval !== contextInterval) {
    issues.push(`context_interval=${contextInterval}`)
  }
  if (requestedAsset && context.requested_asset_class && requestedAsset !== context.requested_asset_class) {
    issues.push(`context_asset_class=${context.requested_asset_class}`)
  }

  return issues
}

function dataRequestContextMismatchBlock(input: {
  prompt: string
  workspace: string | null
  context?: WorkspaceRequestContext
}): string | undefined {
  const facts = parseRequestFacts(input.prompt)
  if (!requestHasIdentity(facts)) return undefined

  const requestedSymbol = normalizeSymbol(facts.requested_symbol)
  const contextUniverse = input.context?.requested_symbols?.map((symbol) => normalizeSymbol(symbol)).filter(Boolean)
  const childInContextUniverse = Boolean(requestedSymbol && contextUniverse?.includes(requestedSymbol))

  const issues = [
    ...(childInContextUniverse ? [] : workspaceMismatchIssues(input.workspace, facts)),
    ...contextMismatchIssues(input.context, facts),
  ]

  if (issues.length === 0) return undefined

  return [
    `BLOCKED: data request context mismatch — workspace is ${input.workspace ?? "MISSING"} but data_extractor task explicitly requested ${describeRequestFacts(facts)}.`,
    "Start a new workspace or rebind the session before extracting; do not reuse existing workspace artifacts.",
    `Conflicts: ${issues.join(", ")}.`,
  ].join(" ")
}

function finnySubagentType(subagentType: string) {
  return (
    subagentType === "data_extractor" ||
    subagentType === "news_agent" ||
    subagentType === "researcher" ||
    subagentType === "sec_agent" ||
    subagentType === "sentiment_agent"
  )
}

function requestHasIdentity(facts: RequestFacts): boolean {
  return Boolean(
    facts.requested_symbol ||
      facts.requested_symbols?.length ||
      facts.requested_interval ||
      facts.requested_asset_class ||
      facts.requested_algorithm_name,
  )
}

function workspaceMatchesPromptFacts(workspace: string | null, facts: RequestFacts): boolean {
  if (!workspace || !workspaceMatchesRequest(workspace, facts)) return false
  if (facts.requested_algorithm_name) return true
  const symbols = (
    facts.requested_symbols?.length ? facts.requested_symbols : facts.requested_symbol ? [facts.requested_symbol] : []
  )
    .map((symbol) => symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .filter(Boolean)
  if (symbols.length === 0) return true
  const base = (workspace.split(".")[0] ?? workspace).toLowerCase()
  return symbols.every((symbol) => base.includes(symbol))
}

async function readRuntimeRequestFacts(requestID: string): Promise<RequestFacts> {
  const spec = await readRequestSpec({ requestID })
  if (!spec) return {}
  return {
    requested_symbol: spec.requested_symbol,
    requested_symbols: spec.requested_symbols,
    requested_interval: spec.requested_interval,
    requested_asset_class: spec.requested_asset_class,
    requested_algorithm_name: spec.requested_algorithm_name,
  }
}

function promptConflictWithParentRequest(parentFacts: RequestFacts, promptFacts: RequestFacts): string | undefined {
  if (!requestHasIdentity(parentFacts) || !requestHasIdentity(promptFacts)) return undefined
  const promptSymbols = promptFacts.requested_symbols?.length
    ? promptFacts.requested_symbols
    : promptFacts.requested_symbol
      ? [promptFacts.requested_symbol]
      : [undefined]
  for (const symbol of promptSymbols) {
    const result = verifyIdentity(parentFacts, {
      actual_symbol: symbol,
      actual_interval: promptFacts.requested_interval,
      actual_asset_class: promptFacts.requested_asset_class,
      algorithm_name: promptFacts.requested_algorithm_name,
    })
    if (result.status === "blocked") return result.blocked
  }
  return undefined
}

function promptMentionsAuthoritativeTarget(prompt: string, parentFacts: RequestFacts): boolean {
  const symbols = parentFacts.requested_symbols?.length
    ? parentFacts.requested_symbols
    : parentFacts.requested_symbol
      ? [parentFacts.requested_symbol]
      : []
  return symbols.some((symbol) => {
    const normalized = normalizeSymbol(symbol)
    if (!normalized) return false
    const pattern = normalized
      .split(/[^A-Z0-9]+/i)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s./:_-]*")
    return new RegExp(`(^|[^A-Z0-9])${pattern}([^A-Z0-9]|$)`, "i").test(prompt)
  })
}

function childSymbolWithinRequestUniverse(symbol: string | undefined, facts: RequestFacts): string | undefined {
  const normalized = normalizeSymbol(symbol)
  if (!normalized || !facts.requested_symbols?.length) return undefined
  const universe = facts.requested_symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
  return universe.includes(normalized) ? normalized : undefined
}

function childSymbolWithinContextUniverse(
  symbol: string | undefined,
  context: WorkspaceRequestContext | undefined,
): string | undefined {
  const normalized = normalizeSymbol(symbol)
  if (!normalized || !context?.requested_symbols?.length) return undefined
  const universe = context.requested_symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
  return universe.includes(normalized) ? normalized : undefined
}

function explicitExistingAlgorithmName(prompt: string, facts: RequestFacts) {
  return /\b(?:improv(?:e|ing)|update|refine|existing)\b[\s\S]{0,80}\balgorithm\b/i.test(prompt)
    ? facts.requested_algorithm_name
    : undefined
}

export function withFinnySubagentContext(
  params: { subagent_type: string },
  prompt: string,
  workspace: string | null,
  context?: WorkspaceRequestContext,
) {
  if (!finnySubagentType(params.subagent_type)) return prompt
  // News agents still need a wall-clock retrieval anchor when no workspace is bound,
  // so sourced_fact retrieved_at does not rely on the model inventing a timestamp.
  if (!workspace) {
    if (params.subagent_type !== "news_agent" && params.subagent_type !== "researcher") return prompt
    const retrievalTimeUtc = new Date().toISOString()
    return [
      "<finny-subagent-context>",
      "Authoritative runtime context. It overrides conflicting task wording.",
      field("retrieval_time_utc", retrievalTimeUtc),
      "",
      "Use retrieval_time_utc for the news evidence timestamp.",
      "</finny-subagent-context>",
      "",
      prompt,
    ].join("\n")
  }

  const workspacePath = algoDir(workspace)
  const dataDir = path.join(workspacePath, "data")
  const newsDir = path.join(dataDir, "news")
  const facts = parseRequestFacts(prompt)
  const childSymbol =
    params.subagent_type === "data_extractor"
      ? childSymbolWithinContextUniverse(facts.requested_symbol, context)
      : undefined
  const window = extractDateWindow(prompt)
  const inferred = inferBacktestWindow(prompt)
  const symbol = childSymbol ?? context?.requested_symbol ?? facts.requested_symbol
  const symbolsOrUniverse =
    childSymbol ?? context?.requested_symbols?.join(", ") ?? facts.requested_symbols?.join(", ") ?? symbol
  const interval = context?.requested_interval ?? facts.requested_interval
  const assetClass =
    context?.requested_asset_class ??
    facts.requested_asset_class ??
    assetClassForSymbol(symbol ?? facts.requested_symbols?.[0])
  const algorithmName =
    explicitExistingAlgorithmName(prompt, facts) ??
    context?.requested_algorithm_name ??
    facts.requested_algorithm_name ??
    algorithmNameFromWorkspaceSlug(workspace)
  const dataWindow = completedIntradayWindow({
    start: context?.requested_start ?? window.start ?? inferred.start,
    end: context?.requested_end ?? window.end ?? inferred.end,
    interval,
  })

  if (params.subagent_type === "data_extractor") {
    const intent = withoutDataRequestBlock(prompt)
    return [
      "<data-request>",
      field("request_id", context?.request_id),
      field("algorithm", algorithmName),
      field("workspace", workspace),
      field("symbols", symbolsOrUniverse),
      field("asset_class", assetClass),
      field("interval", interval),
      field("start_inclusive", dataWindow.start),
      field("end_inclusive", dataWindow.end),
      field("provider", dataRequestProvider(prompt) ?? explicitlyRequestedDataProvider(prompt) ?? "auto"),
      field("output_dir", dataDir),
      "</data-request>",
      ...(intent ? ["", intent] : []),
    ].join("\n")
  }

  if (params.subagent_type === "sec_agent") {
    const secDir = path.join(dataDir, "sec")
    const secContext = parseSecRequestContext(prompt)
    return [
      "<finny-subagent-context>",
      "Authoritative SEC artifact context:",
      field("company_or_ticker", symbolsOrUniverse ?? secContext.requested_company_or_ticker),
      field("resolved_symbol", symbolsOrUniverse ?? secContext.resolved_symbol),
      field("resolved_cik", secContext.resolved_cik),
      field("person", secContext.requested_person),
      field("institution", secContext.requested_institution),
      field("start_date", secContext.date_start ?? context?.requested_start ?? window.start),
      field("end_date", secContext.date_end ?? context?.requested_end ?? window.end),
      "- end_date_inclusive: true",
      field("workspace", secDir),
      field("allowed_sec_dir", secDir),
      field("analysis_intent", secContext.analysis_intent ?? prompt.slice(0, 240)),
      "",
      "Use `allowed_sec_dir` for durable artifacts and follow the SEC Agent evidence contract.",
      "</finny-subagent-context>",
      "",
      prompt,
    ].join("\n")
  }

  if (params.subagent_type === "sentiment_agent") {
    const sentimentDir = path.join(dataDir, "sentiment")
    const sentimentSymbol = (symbolsOrUniverse || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9._-]/g, "_")
    const sentimentStart = (dataWindow.start || "START").replace(/[^A-Z0-9._-]/gi, "_")
    const sentimentEnd = (dataWindow.end || "END").replace(/[^A-Z0-9._-]/gi, "_")
    const sentimentArtifactStem = `${sentimentSymbol}_${sentimentStart}_${sentimentEnd}_sentiment`
    const expectedSentimentCsvPath = path.join(sentimentDir, `${sentimentArtifactStem}.csv`)
    const expectedSentimentManifestPath = path.join(sentimentDir, `${sentimentArtifactStem}.manifest.json`)
    return [
      "<finny-subagent-context>",
      "Authoritative sentiment artifact context:",
      field("requested_algorithm_name", algorithmName),
      field("symbol", symbolsOrUniverse),
      field("start_date", dataWindow.start),
      field("end_date", dataWindow.end),
      "- end_date_inclusive: true",
      field("workspace", sentimentDir),
      field("asset_class", assetClass),
      field("interval", interval),
      field("allowed_sentiment_dir", sentimentDir),
      field("expected_sentiment_csv_path", expectedSentimentCsvPath),
      field("expected_sentiment_manifest_path", expectedSentimentManifestPath),
      dataWindow.adjusted
        ? "- window_adjustment: intraday rolling window capped at the last fully completed UTC date; do not require future social data from the current UTC day."
        : undefined,
      "",
      "Use the expected paths for useful aggregate artifacts; raw social text must remain transient.",
      "</finny-subagent-context>",
      "",
      prompt,
    ].join("\n")
  }

  const retrievalTimeUtc = new Date().toISOString()
  return [
    "<finny-subagent-context>",
    "Authoritative runtime context. It overrides conflicting task wording.",
    field("workspace_slug", workspace),
    ...requestLineageFields(context),
    field("workspace_name", humanNameOf(workspace)),
    field("requested_algorithm_name", context?.requested_algorithm_name ?? facts.requested_algorithm_name),
    field("requested_symbol", symbolsOrUniverse),
    field("requested_interval", interval),
    field("requested_asset_class", assetClass),
    field("workspace_news_dir", newsDir),
    field("retrieval_time_utc", retrievalTimeUtc),
    "",
    "Write at most one note directly under `workspace_news_dir`; do not write elsewhere or create nested folders.",
    "Use retrieval_time_utc for the news evidence timestamp and follow the News Agent evidence contract.",
    "</finny-subagent-context>",
    "",
    prompt,
  ].join("\n")
}

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
}

export const TaskStartParameters = Schema.Struct({
  ...BaseParameterFields,
})

export const TaskRunParameters = Schema.Struct({ ...BaseParameterFields })

const BatchTaskParameters = Schema.Struct({
  description: BaseParameterFields.description,
  prompt: BaseParameterFields.prompt,
  subagent_type: BaseParameterFields.subagent_type,
})

export const TaskBatchRunParameters = Schema.Struct({
  tasks: Schema.Array(BatchTaskParameters).check(Schema.isLengthBetween(2, 4)).annotate({
    description:
      "Two to four independent foreground subagents to launch together. All results are returned, including BLOCKED results.",
  }),
})

type TaskStartParameters = Schema.Schema.Type<typeof TaskStartParameters>
type TaskRunParameters = Schema.Schema.Type<typeof TaskRunParameters>
type SingleTaskParameters = TaskStartParameters | TaskRunParameters
type TaskBatchRunParameters = Schema.Schema.Type<typeof TaskBatchRunParameters>

function closedJsonSchema(schema: Schema.Top, nestedArrayProperty?: string): JSONSchema7 {
  const json = ToolJsonSchema.fromSchema(schema)
  const property = nestedArrayProperty ? json.properties?.[nestedArrayProperty] : undefined
  const array = property && typeof property === "object" && "items" in property ? property : undefined
  const items = array?.items
  return {
    ...json,
    additionalProperties: false,
    ...(array && items && !Array.isArray(items) && typeof items === "object"
      ? {
          properties: {
            ...json.properties,
            [nestedArrayProperty!]: {
              ...array,
              items: { ...items, additionalProperties: false },
            },
          },
        }
      : {}),
  }
}

type TaskMetadata = {
  parentSessionId?: SessionID
  sessionId: SessionID
  model?: { modelID: string; providerID: string }
  background?: boolean
  jobId?: string
  batch?: boolean
  taskCount?: number
  subagentTypes?: string[]
  subagents?: Array<{
    sessionId: SessionID
    subagentType: string
    description: string
    state: "running" | "completed" | "error"
  }>
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function renderBatchOutput(
  results: Array<{
    index: number
    subagentType: string
    description: string
    state: "completed" | "error" | "running"
    text: string
  }>,
) {
  return [
    `<task_batch state="${results.some((result) => result.state === "running") ? "running" : "completed"}">`,
    ...results.flatMap((result) => [
      `<batch_item index="${result.index}" subagent_type="${result.subagentType}" state="${result.state}">`,
      `<summary>${result.description}</summary>`,
      result.text,
      "</batch_item>",
    ]),
    "</task_batch>",
  ].join("\n")
}

function taskResultStatus(text: string): Extract<TaskState.Status, "blocked" | "completed"> {
  return /\bBLOCKED:/.test(text) ? TaskState.Status.blocked : TaskState.Status.completed
}

function summarizeTaskResult(text: string) {
  const trimmed = text.trim()
  return trimmed.length > 4_000 ? trimmed.slice(0, 4_000) : trimmed
}

const DATA_EXTRACTOR_REPAIR_ATTEMPTS = 1

export function dataExtractorRepairInstruction(partial: PartialDataExtractorEvidence): string {
  return [
    "<data-repair>",
    `Continue this same extraction task for ${partial.requestedSymbol} ${partial.requestedInterval}, ${partial.requestedStart} through ${partial.requestedEnd}.`,
    `Progress: ${partial.rows} canonical rows; missing=${partial.missingCount}; extra=${partial.extraCount}.`,
    `Canonical CSV: ${partial.csvPath}`,
    `Evidence manifest: ${partial.manifestPath} (timestamps.missing_ranges is the exact repair target).`,
    `Missing ranges: ${JSON.stringify(partial.missingRanges)}`,
    "Fetch only those missing ranges. Do not redownload the full window or create another canonical dataset.",
    "Try compatible alternative sources where useful, merge into the existing CSV, deduplicate by timestamp, and preserve source provenance in the analysis/limitations artifact.",
    "Generate or refresh the coverage, regime, and candidate-hypothesis artifacts even if coverage remains partial.",
    "Keep the requested symbol, interval, and dates unchanged, then run the evidence finalizer again.",
    "If compatible sources are exhausted, leave the valid partial CSV and its coverage/regime/hypothesis artifacts in place and report that limitation.",
    "</data-repair>",
  ].join("\n")
}

const EVIDENCE_AGENT_TYPES = new Set(["data_extractor", "news_agent", "researcher", "sec_agent", "sentiment_agent"])

const EXPLICIT_EVIDENCE_REQUEST =
  /\b(?:evidence|extract(?:ion)?|historical data|market data|news|catalysts?|filings?|sec|sentiment|strict|qualif(?:y|ication))\b/i

const BACKTEST_ONLY_REQUEST = /\b(?:backtest(?:ing)?|re-?run|run again|retest(?:ing)?)\b/i
const NEW_BUILD_REQUEST =
  /\b(?:build|create|design|make|new)\b[^\n]{0,80}\b(?:strategy|strat|algorithm|algo)\b|\b(?:strategy|strat|algorithm|algo)\b[^\n]{0,80}\b(?:build|create|design|make|new)\b/i

type EvidenceDelegationWorkflow = Pick<
  BuildWorkflowState,
  "requestVersion" | "phase" | "evidence" | "researchFreeze" | "candidate" | "experimentPlan" | "attempts"
>

function hasEnteredStrictWorkflow(state: EvidenceDelegationWorkflow | undefined) {
  if (!state) return false
  return (
    state.evidence.length > 0 ||
    !!state.researchFreeze ||
    !!state.candidate ||
    !!state.experimentPlan ||
    [
      "evidence_ready",
      "research_frozen",
      "candidate_validated",
      "experiment_planned",
      "strict_running",
      "strict_blocked",
      "qualified",
      "terminal_complete",
    ].includes(state.phase)
  )
}

export function shouldBackgroundRecommendedEvidence(input: {
  agent: string
  subagentType: string
  latestUserText: string
  workflow?: EvidenceDelegationWorkflow
}) {
  return (
    BuildWorkflow.isBuildAgent(input.agent) &&
    EVIDENCE_AGENT_TYPES.has(input.subagentType) &&
    input.latestUserText.trim().length > 0 &&
    !hasEnteredStrictWorkflow(input.workflow) &&
    !BACKTEST_ONLY_REQUEST.test(input.latestUserText)
  )
}

export function evidenceDelegationBlock(input: {
  subagentType: string
  latestUserText: string
  workflow?: EvidenceDelegationWorkflow
}) {
  if (!EVIDENCE_AGENT_TYPES.has(input.subagentType) || !input.workflow) return undefined
  if (EXPLICIT_EVIDENCE_REQUEST.test(input.latestUserText)) return undefined
  // Evidence is relevance-based for new strategy work. Suppress automatic
  // delegation only for ordinary backtest/rerun requests, where the runner can
  // reuse matching data or fetch provider data directly.
  if (!BACKTEST_ONLY_REQUEST.test(input.latestUserText) || NEW_BUILD_REQUEST.test(input.latestUserText))
    return undefined
  const state = input.workflow
  const strictWorkflowStarted = hasEnteredStrictWorkflow(state)
  if (strictWorkflowStarted) return undefined
  const exploratoryBacktestComplete = state.attempts.some(
    (attempt) =>
      attempt.operation === "finny_backtest:finish" &&
      attempt.lifecycle === "terminal" &&
      attempt.outcome === "accepted" &&
      attempt.requestVersion === state.requestVersion,
  )
  if (exploratoryBacktestComplete) return undefined
  return [
    "SKIPPED: this is a backtest-only or rerun request, so no new evidence subagent was launched.",
    "For this request, delegate evidence only if the user explicitly asks for evidence/news/data extraction or the workflow enters strict qualification.",
    "Do not retry the same evidence task before one of those conditions changes.",
  ].join(" ")
}

export function taskRegistryErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return [
    "BLOCKED: internal task registry error.",
    "The subagent did not launch because Finny could not record its task lifecycle.",
    `Registry error: ${message.slice(0, 500)}`,
    "Restart Finny with the latest build and let migrations run before retrying. Do not retry this task until the registry is healthy.",
  ].join(" ")
}

const taskExecutor = Effect.gen(function* () {
  const agent = yield* Agent.Service
  const background = yield* BackgroundJob.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const workflow = yield* BuildWorkflow.Service
  // ToolRegistry's lightweight test/runtime construction does not always
  // include session status, so use it as a readiness optimization when the
  // service is present and retain BusyError-based admission as the fallback.
  const sessionStatus = yield* Effect.serviceOption(SessionStatus.Service)
  const scope = yield* Scope.Scope
  const database = yield* Database.Service
  const runSingle = Effect.fn("TaskTool.executeSingle")(function* (
    params: SingleTaskParameters,
    ctx: Tool.Context,
    options: { mode: "background" | "foreground"; batch?: boolean },
  ) {
    const fundDelegationIssue = fundDelegationError(ctx.agent, params.subagent_type)
    if (fundDelegationIssue) return yield* Effect.fail(new Error(fundDelegationIssue))
    const cfg = yield* config.get()
    const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
      Effect.provideService(Database.Service, database),
      Effect.orDie,
    )
    if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
    const workflowRunID = msg.info.parentID
    const latestUserMessage = msg.info.parentID
      ? yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: msg.info.parentID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : undefined
    const latestUserText =
      latestUserMessage?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") ?? ""
    const fundSpecialistAgent = isFundSpecialistAgent(params.subagent_type) ? params.subagent_type : undefined
    const fundLaunch = fundSpecialistAgent
      ? yield* Effect.promise(() =>
          FundCaseStore.specialistLaunchStatus(
            {
              managerSessionID: ctx.sessionID,
              triggerMessageID: workflowRunID,
              agent: fundSpecialistAgent,
            },
            database,
          ),
        )
      : undefined
    if (fundLaunch && !fundLaunch.allowed) {
      return {
        title: `${params.subagent_type} launch rejected`,
        metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
        output: `BLOCKED: ${fundLaunch.message}`,
      }
    }
    const activeWorkflow = EVIDENCE_AGENT_TYPES.has(params.subagent_type)
      ? yield* activeWorkflowForSession(ctx.sessionID).pipe(Effect.provideService(Database.Service, database))
      : undefined
    // The enclosing batch validates the complete role set atomically before
    // invoking its individual children.
    if (activeWorkflow && BuildWorkflow.isBuildAgent(ctx.agent) && options.batch !== true) {
      const launchBlock = StrategyContext.requiredContextLaunchBlock({
        workflow: activeWorkflow,
        tasks: yield* Effect.promise(() => StrategyContext.contextTasks(ctx.sessionID, database)),
        requestedRoles: [params.subagent_type],
        batch: false,
      })
      if (launchBlock) {
        return {
          title: "Strategy-context kickoff incomplete",
          metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
          output: launchBlock,
        }
      }
    }
    const optionalEvidenceBlock = evidenceDelegationBlock({
      subagentType: params.subagent_type,
      latestUserText,
      workflow: activeWorkflow,
    })
    if (optionalEvidenceBlock) {
      return {
        title: "Evidence optional for exploratory backtest",
        metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
        output: optionalEvidenceBlock,
      }
    }
    if (params.task_id) {
      const activeTask = yield* Effect.promise(() => TaskState.get(params.task_id!, database))
      if (isFundSpecialistAgent(params.subagent_type)) {
        return yield* Effect.fail(
          new Error(
            "Protected fund specialist tasks cannot be resumed by task_id; retry a terminal failure with a fresh registered child.",
          ),
        )
      }
      if (
        activeTask &&
        activeTask.parentSessionID === ctx.sessionID &&
        TaskState.isTerminal(activeTask.status) &&
        BuildWorkflow.isBuildAgent(ctx.agent) &&
        EVIDENCE_AGENT_TYPES.has(activeTask.subagentType)
      ) {
        return {
          title: `Fresh ${activeTask.subagentType} launch required`,
          metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
          output: [
            `The requested task_id belongs to a terminal ${activeTask.subagentType} task.`,
            "Do not re-steer a terminal strategy-context child: its prior output and launch context are immutable.",
            `Call task_run again for ${params.subagent_type} without task_id so the retry gets a fresh child session and authoritative launch context.`,
          ].join(" "),
        }
      }
      if (
        activeTask &&
        activeTask.parentSessionID === ctx.sessionID &&
        activeTask.mode === "background" &&
        !TaskState.isTerminal(activeTask.status) &&
        (requestsActiveBackgroundResult(params) ||
          (BuildWorkflow.isBuildAgent(ctx.agent) && EVIDENCE_AGENT_TYPES.has(activeTask.subagentType)))
      ) {
        return {
          title: `${activeTask.subagentType} still running`,
          metadata: {
            parentSessionId: ctx.sessionID,
            sessionId: activeTask.id,
            background: true,
            jobId: activeTask.id,
          },
          output: renderOutput({
            sessionID: activeTask.id,
            state: "running",
            summary: "Background task still running",
            text: "This background task is still active with authoritative launch context. Its completion result will be delivered automatically; do not poll, re-steer, extend, restart, or duplicate it.",
          }),
        }
      }
    }
    if (
      !params.task_id &&
      ((BuildWorkflow.isBuildAgent(ctx.agent) && EVIDENCE_AGENT_TYPES.has(params.subagent_type)) ||
        params.subagent_type === "data_extractor")
    ) {
      const activeSameRole = (yield* Effect.promise(() => TaskState.listByParent(ctx.sessionID, database))).find(
        (task) => task.subagentType === params.subagent_type && !TaskState.isTerminal(task.status),
      )
      if (activeSameRole) {
        return {
          title: `${params.subagent_type} already running`,
          metadata: {
            parentSessionId: ctx.sessionID,
            sessionId: activeSameRole.id,
            background: true,
            jobId: activeSameRole.id,
          },
          output: renderOutput({
            sessionID: activeSameRole.id,
            state: "running",
            summary: "Existing background task reused",
            text: "A matching strategy-context role is already active for this parent session. Wait for its automatic completion result; do not launch a duplicate.",
          }),
        }
      }
    }
    const guardedDataExtraction = BuildWorkflow.isBuildAgent(ctx.agent) && params.subagent_type === "data_extractor"
    const strictWorkflowStarted = hasEnteredStrictWorkflow(activeWorkflow)
    const recommendedEvidence = shouldBackgroundRecommendedEvidence({
      agent: ctx.agent,
      subagentType: params.subagent_type,
      latestUserText,
      workflow: activeWorkflow,
    })
    const mandatoryEvidence =
      BuildWorkflow.isBuildAgent(ctx.agent) &&
      strictWorkflowStarted &&
      BuildWorkflow.isMandatoryEvidenceRole(params.subagent_type)
    const approvedWindow = guardedDataExtraction
      ? yield* Effect.promise(async () => {
          const window = await readWorkspaceDateWindow(String(ctx.sessionID))
          return window.requested_start && window.requested_end
            ? `${window.requested_start}:${window.requested_end}:${window.requested_interval ?? ""}`
            : undefined
        })
      : undefined
    // Recommended evidence must not stall the parent build turn. Even if the
    // model selected task_run, keep it in the background until the workflow
    // actually enters strict qualification.
    const runInBackground = recommendedEvidence || (mandatoryEvidence ? false : options.mode === "background")
    // Permission and agent resolution precede workflow registration so a
    // denied or unknown task cannot create a running fingerprint.
    if (!ctx.extra?.bypassAgentCheck) {
      yield* ctx.ask({
        permission,
        patterns: [params.subagent_type],
        always: ["*"],
        metadata: { description: params.description, subagent_type: params.subagent_type },
      })
    }
    const next = yield* agent.get(params.subagent_type)
    if (!next) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
    }
    const preflightBlock = yield* Effect.promise(async () => {
      const boundParentWorkspace = await getSessionWorkspace(ctx.sessionID).catch(() => null)
      // Once a Build workflow exists, its persisted workspace is canonical.
      // Do not let a child research prompt or a stale session binding move the
      // parent into another symbol's workspace.
      const parentWorkspace = activeWorkflow?.workspaceSlug ?? boundParentWorkspace
      if (parentWorkspace && parentWorkspace !== boundParentWorkspace) {
        await bindSessionWorkspace(ctx.sessionID, parentWorkspace)
      }
      if (guardedDataExtraction && parentWorkspace) {
        const promptFacts = parseRequestFacts(params.prompt)
        const parentFacts = await readRuntimeRequestFacts(ctx.sessionID)
        const conflict = parentFacts.requested_symbols?.length
          ? promptConflictWithParentRequest(parentFacts, promptFacts)
          : requestHasIdentity(parentFacts) && !promptFacts.requested_symbols?.length
            ? dataRequestContextMismatchBlock({
                prompt: params.prompt,
                workspace: parentWorkspace,
                context: parentFacts as WorkspaceRequestContext,
              })
            : undefined
        if (conflict) return conflict
      }
      if (params.subagent_type !== "data_extractor") return undefined
      const existing = await readWorkspaceDateWindow(String(ctx.sessionID))
      if (!existing.authoritative) return undefined
      return dataExtractorWindowBlock({ prompt: params.prompt, workspace: parentWorkspace, existing })
    })
    if (preflightBlock) {
      return {
        title: params.description,
        metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
        output: [
          "Evidence request rejected before launch.",
          preflightBlock,
          "The invalid task was not registered and did not terminalize this Build run.",
          "Retry once after correcting the authoritative request identity above.",
        ].join("\n"),
      }
    }
    if (!params.task_id && params.subagent_type === "data_extractor") {
      const priorTerminalExtractor = (yield* Effect.promise(() =>
        TaskState.listByParent(ctx.sessionID, database),
      )).findLast((task) => task.subagentType === "data_extractor" && TaskState.isTerminal(task.status))
      if (priorTerminalExtractor) {
        const parentWorkspace =
          activeWorkflow?.workspaceSlug ??
          (yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null)))
        const parentContext = yield* Effect.promise(() => readRuntimeRequestFacts(ctx.sessionID))
        const contextMismatch = dataRequestContextMismatchBlock({
          prompt: params.prompt,
          workspace: parentWorkspace,
          context: parentContext as WorkspaceRequestContext,
        })
        const validationContext = dataExtractorValidationContext(
          parentContext as WorkspaceRequestContext,
          parseRequestFacts(params.prompt),
        )
        const existing = yield* Effect.promise(() =>
          validateExistingDataExtractorEvidence({
            workspaceSlug: parentWorkspace,
            context: validationContext,
            requestedProvider: explicitlyRequestedDataProvider(params.prompt),
          }),
        )
        if (!contextMismatch && existing.result?.partialEvidence) {
          return {
            title: "Existing partial data extraction reused",
            metadata: {
              parentSessionId: ctx.sessionID,
              sessionId: priorTerminalExtractor.id,
            } as TaskMetadata,
            output: renderOutput({
              sessionID: priorTerminalExtractor.id,
              state: "completed",
              summary: "Bounded repair already completed",
              text: renderPartialDataExtractorHandoff(existing.result.partialEvidence),
            }),
          }
        }
      }
    }
    const durableFingerprint = mandatoryEvidence
      ? BuildWorkflow.taskFingerprint({
          role: params.subagent_type,
          prompt: params.prompt,
          providerID: msg.info.providerID,
          recoveryRevision: approvedWindow,
        })
      : undefined
    const durableStart =
      mandatoryEvidence && durableFingerprint
        ? yield* recordWorkflowAttempt({
            sessionId: ctx.sessionID,
            operation: `task:${params.subagent_type}`,
            fingerprint: durableFingerprint,
            idempotencyKey: `begin:${durableFingerprint}`,
            outcome: "accepted",
          }).pipe(Effect.provideService(Database.Service, database))
        : undefined
    if (durableStart && !durableStart.allowed) {
      return {
        title: params.description,
        metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
        output: [
          "Mandatory evidence durable retry denied.",
          BuildWorkflow.terminalBlock({
            fingerprint: durableFingerprint!,
            status: "blocked",
            reason: durableStart.message,
          }),
        ].join("\n"),
      }
    }
    const workflowProjection = mandatoryEvidence
      ? yield* workflow.projectEvidenceStart({
          sessionID: ctx.sessionID,
          workflowRunID,
          role: params.subagent_type,
          prompt: params.prompt,
          providerID: msg.info.providerID,
          recoveryRevision: approvedWindow,
        })
      : undefined

    const recordDurableFinish = Effect.fn("TaskTool.recordDurableFinish")(function* (
      status: "blocked" | "completed" | "failed" | "cancelled",
      output?: string,
    ) {
      if (!durableFingerprint) return
      yield* recordWorkflowAttempt({
        sessionId: ctx.sessionID,
        operation: `task:${params.subagent_type}:finish`,
        fingerprint: durableFingerprint,
        idempotencyKey: `finish:${durableFingerprint}:${status}`,
        outcome: status === "completed" ? "accepted" : status === "blocked" ? "blocked" : "failed",
        lifecycle: "terminal",
        blockerCode:
          status === "blocked"
            ? "mandatory_evidence_blocked"
            : status === "completed"
              ? undefined
              : `mandatory_evidence_${status}`,
        requiredChanges:
          status === "completed" ? [] : ["request identity", "evidence window", "provider", "runtime blocker"],
      }).pipe(Effect.provideService(Database.Service, database), Effect.asVoid)
    })

    const session = params.task_id
      ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    if (
      params.task_id &&
      isFundRuntimeAgent(next.name) &&
      (!session ||
        session.parentID !== ctx.sessionID ||
        session.agent !== next.name ||
        session.permission?.some((rule) => rule.action === "allow"))
    ) {
      return yield* Effect.fail(new Error("Protected fund task_id lineage or canonical permissions do not match."))
    }
    const parent = yield* sessions.get(ctx.sessionID)
    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: next,
    })
    const effectiveChildPermission = effectiveFundRuntimePermission(next.name, next.permission)
    const protectedFundChild = isFundRuntimeAgent(next.name)
    const childToolDenies = [
      ...((protectedFundChild
        ? Permission.evaluate("todowrite", "*", effectiveChildPermission).action === "allow"
        : next.permission.some((rule) => rule.permission === "todowrite"))
        ? []
        : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
      ...((protectedFundChild
        ? Permission.evaluate(permission, "*", effectiveChildPermission).action === "allow"
        : next.permission.some((rule) => rule.permission === permission))
        ? []
        : [{ permission, pattern: "*" as const, action: "deny" as const }]),
      ...(cfg.experimental?.primary_tools?.map((permission) => ({
        permission,
        pattern: "*" as const,
        action: "deny" as const,
      })) ?? []),
    ]
    const nextSession =
      session ??
      (yield* sessions.create({
        parentID: ctx.sessionID,
        title: params.description + ` (@${next.name} subagent)`,
        agent: next.name,
        permission: [
          ...childPermission,
          ...childToolDenies.filter(
            (deny) =>
              !childPermission.some(
                (rule) =>
                  rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
              ),
          ),
        ],
      }))

    if (workflowProjection) {
      yield* workflow.attachSession({
        sessionID: ctx.sessionID,
        workflowRunID,
        fingerprint: workflowProjection.fingerprint,
        taskSessionID: nextSession.id,
      })
    }

    // Subagents inherit the parent session's algo workspace binding so data
    // extraction and research notes land in the same per-request workspace.
    const workspaceState = yield* Effect.promise(async () => {
      const boundParentWorkspace = await getSessionWorkspace(ctx.sessionID).catch(() => null)
      const parentWorkspace = activeWorkflow?.workspaceSlug ?? boundParentWorkspace
      const childWorkspace = await getSessionWorkspace(nextSession.id).catch(() => null)
      const promptFacts = parseRequestFacts(params.prompt)
      const explicitExistingAlgorithm = explicitExistingAlgorithmName(params.prompt, promptFacts)
      const parentFacts = await readRuntimeRequestFacts(ctx.sessionID)
      // Research/context agents commonly mention auxiliary instruments (for
      // example VIX while researching SPY) and shorter catalyst windows. When
      // the prompt explicitly retains an authoritative parent target, those
      // references enrich the same workspace instead of rebinding it. Raw data
      // extraction remains strict because its files define backtest identity.
      const auxiliaryContextForParent =
        params.subagent_type !== "data_extractor" && promptMentionsAuthoritativeTarget(params.prompt, parentFacts)
      const inParentUniverse = finnySubagentType(params.subagent_type)
        ? childSymbolWithinRequestUniverse(promptFacts.requested_symbol, parentFacts)
        : undefined
      const parentConflict =
        finnySubagentType(params.subagent_type) && parentFacts.requested_symbols?.length && !auxiliaryContextForParent
          ? promptConflictWithParentRequest(parentFacts, promptFacts)
          : undefined
      if (parentWorkspace && parentConflict) {
        return { slug: parentWorkspace, blocked: parentConflict }
      }
      const singleTargetConflict =
        parentWorkspace &&
        finnySubagentType(params.subagent_type) &&
        requestHasIdentity(parentFacts) &&
        !parentFacts.requested_symbols?.length &&
        !promptFacts.requested_symbols?.length &&
        !auxiliaryContextForParent
          ? dataRequestContextMismatchBlock({
              prompt: params.prompt,
              workspace: parentWorkspace,
              context: parentFacts as WorkspaceRequestContext,
            })
          : undefined
      if (singleTargetConflict) {
        return { slug: parentWorkspace, blocked: singleTargetConflict }
      }
      let workspace =
        parentWorkspace && (inParentUniverse || auxiliaryContextForParent)
          ? parentWorkspace
          : workspaceMatchesPromptFacts(parentWorkspace, promptFacts)
            ? parentWorkspace
            : workspaceMatchesPromptFacts(childWorkspace, promptFacts)
              ? childWorkspace
              : null
      const useParentContext = Boolean(
        parentWorkspace && workspace === parentWorkspace && requestHasIdentity(parentFacts),
      )
      if (
        finnySubagentType(params.subagent_type) &&
        (!workspace || (requestHasIdentity(promptFacts) && !useParentContext))
      ) {
        workspace = (await bootstrapWorkspace(ctx.sessionID, params.prompt).catch(() => undefined))?.slug ?? workspace
      }
      if (workspace) {
        await bindSessionWorkspace(ctx.sessionID, workspace).catch(() => {})
        await bindSessionWorkspace(nextSession.id, workspace).catch(() => {})
        await bindSessionRequest({ sessionID: nextSession.id, requestID: ctx.sessionID })
      }
      return {
        slug: workspace,
        preserveExistingContext: Boolean(
          parentWorkspace &&
            workspace === parentWorkspace &&
            requestHasIdentity(parentFacts) &&
            !explicitExistingAlgorithm,
        ),
      }
    })
    const workspace = workspaceState.slug

    const variant = msg.info.variant

    const model = next.model ?? {
      modelID: msg.info.modelID,
      providerID: msg.info.providerID,
    }
    const metadata: TaskMetadata = {
      parentSessionId: ctx.sessionID,
      sessionId: nextSession.id,
      model,
      ...(runInBackground ? { background: true } : {}),
    }

    const mode = runInBackground ? "background" : "foreground"
    // The scripted fixture keeps real child sessions/tools but bypasses the
    // optional task registry, whose lazy dev migration can race in a fresh
    // isolated database. This path is unavailable to live-model harnesses.
    const scriptedHarness =
      process.env.FINNY_HARNESS_MODE === "1" &&
      process.env.FINNY_HARNESS_SCRIPTED_MODEL === "1" &&
      !isFundRuntimeAgent(ctx.agent) &&
      !isFundSpecialistAgent(params.subagent_type)
    const registryExit = scriptedHarness
      ? Exit.succeed(undefined)
      : yield* Effect.exit(
          Effect.promise(async () => {
            const existingTask = await TaskState.get(nextSession.id, database)
            if (!existingTask) {
              await TaskState.upsert(
                {
                  id: nextSession.id,
                  parentSessionID: ctx.sessionID,
                  description: params.description,
                  subagentType: params.subagent_type,
                  mode,
                  status: TaskState.Status.queued,
                },
                database,
              )
            }
            if (isFundSpecialistAgent(params.subagent_type)) {
              await FundCaseStore.admitChildAttempt(
                {
                  managerSessionID: ctx.sessionID,
                  triggerMessageID: workflowRunID,
                  childSessionID: nextSession.id,
                  agent: params.subagent_type,
                },
                database,
              )
            }
          }),
        )
    if (Exit.isFailure(registryExit)) {
      if (workflowProjection) {
        yield* workflow.finishEvidence({
          sessionID: ctx.sessionID,
          workflowRunID,
          fingerprint: workflowProjection.fingerprint,
          status: "failed",
          output: taskRegistryErrorText(Cause.squash(registryExit.cause)),
        })
        yield* recordDurableFinish("failed", taskRegistryErrorText(Cause.squash(registryExit.cause)))
      }
      return {
        title: params.description,
        metadata,
        output: renderOutput({
          sessionID: nextSession.id,
          state: "error",
          summary: "Task registry error",
          text: taskRegistryErrorText(Cause.squash(registryExit.cause)),
        }),
      }
    }

    const fundChildContext = isFundSpecialistAgent(params.subagent_type)
      ? yield* Effect.promise(() => FundCaseStore.childContext(nextSession.id, database))
      : undefined

    yield* ctx.metadata({
      title: params.description,
      metadata,
    })

    const ops = ctx.extra?.promptOps as TaskPromptOps
    if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

    const cancelSiblingTasks = Effect.fn("TaskTool.cancelSiblingTasks")(function* () {
      // Only cancel mandatory evidence workers attached to this Build workflow
      // run — never unrelated background tasks from earlier turns.
      const run = yield* workflow.get({ sessionID: ctx.sessionID, workflowRunID })
      const siblingSessionIDs = new Set(
        [...(run?.tasks.values() ?? [])]
          .filter(
            (record) =>
              record.status === "running" &&
              record.sessionID &&
              record.sessionID !== nextSession.id &&
              BuildWorkflow.isMandatoryEvidenceRole(record.role),
          )
          .map((record) => record.sessionID!),
      )
      if (siblingSessionIDs.size === 0) return
      const active = (yield* Effect.promise(() => TaskState.listByParent(ctx.sessionID, database))).filter(
        (task) => !TaskState.isTerminal(task.status) && siblingSessionIDs.has(task.id),
      )
      yield* Effect.forEach(
        active,
        (task) =>
          Effect.all(
            [
              ops.cancel(task.id),
              background.cancel(task.id),
              Effect.promise(() => TaskState.cancel(task.id, database)).pipe(Effect.asVoid),
              Effect.gen(function* () {
                const fingerprint = [...(run?.tasks.values() ?? [])].find(
                  (record) => record.sessionID === task.id,
                )?.fingerprint
                if (!fingerprint) return
                yield* workflow.finishEvidence({
                  sessionID: ctx.sessionID,
                  workflowRunID,
                  fingerprint,
                  status: "cancelled",
                  output: "Cancelled after sibling mandatory evidence terminalized",
                })
              }),
            ],
            { discard: true },
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

    let verifiedNewsEvidence: { text: string; issues: string[] } | undefined
    const runTask = Effect.fn("TaskTool.runTask")(function* () {
      if (workspaceState.blocked) return workspaceState.blocked
      if (params.subagent_type === "data_extractor" && !workspace) {
        return "BLOCKED: incomplete data request context: missing workspace_slug, allowed_data_dir"
      }
      if (params.subagent_type === "data_extractor") {
        const existingWindow = yield* Effect.promise(() => readWorkspaceDateWindow(String(ctx.sessionID)))
        const dateBlock = dataExtractorWindowBlock({
          prompt: params.prompt,
          workspace,
          existing: existingWindow,
        })
        if (dateBlock) return dateBlock
      }
      let workspaceContext: WorkspaceRequestContext | undefined
      if (
        workspace &&
        (params.subagent_type === "data_extractor" ||
          params.subagent_type === "news_agent" ||
          params.subagent_type === "researcher" ||
          params.subagent_type === "sec_agent" ||
          params.subagent_type === "sentiment_agent")
      ) {
        workspaceContext = yield* Effect.promise(async () => {
          const spec = await readRequestSpec({ requestID: ctx.sessionID })
          if (spec && workspaceState.preserveExistingContext) return requestSpecContext(spec)
          return syncWorkspaceRequestContext({
            sessionID: ctx.sessionID,
            slug: workspace,
            prompt: params.prompt,
            preserveExisting: workspaceState.preserveExistingContext,
            actor: "runtime",
            reason: "validated child task context",
          })
        })
      }
      const validationContext =
        params.subagent_type === "data_extractor"
          ? dataExtractorValidationContext(workspaceContext, parseRequestFacts(params.prompt))
          : workspaceContext
      if (params.subagent_type === "data_extractor") {
        const mismatch = dataRequestContextMismatchBlock({
          prompt: params.prompt,
          workspace,
          context: workspaceContext,
        })
        if (mismatch) return mismatch
        const existing = yield* Effect.promise(() =>
          validateExistingDataExtractorEvidenceSet({
            workspaceSlug: workspace,
            context: validationContext,
            requestedProvider: explicitlyRequestedDataProvider(params.prompt),
          }),
        )
        if (existing.found && existing.result?.ok && !existing.result.partialEvidence) return existing.result.text
      }
      const parts = yield* ops.resolvePromptParts(
        withFinnySubagentContext(
          params,
          fundChildContext ? `${fundChildContext}\n\n${params.prompt}` : params.prompt,
          workspace,
          workspaceContext,
        ),
      )
      let result = yield* ops.prompt({
        messageID: MessageID.ascending(),
        sessionID: nextSession.id,
        ...(isFundRuntimeAgent(next.name)
          ? {}
          : {
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant: next.model ? undefined : variant,
            }),
        agent: next.name,
        parts,
      })
      let text = finalTaskText(result.parts)
      if (params.subagent_type === "news_agent" || params.subagent_type === "researcher") {
        let validated = validateNewsAgentTaskText({
          text,
          workspaceSlug: workspace,
          context: workspaceContext,
        })
        const requiredNewsUnverified =
          params.subagent_type === "news_agent" &&
          activeWorkflow?.evidenceRequirements.some(
            (requirement) =>
              requirement.kind === "news" &&
              requirement.required &&
              !activeWorkflow.evidence.some(
                (record) =>
                  record.requirementId === requirement.id && record.kind === "news" && record.status === "verified",
              ),
          )
        if (validated.claims === undefined && requiredNewsUnverified) {
          const canonicalClaimsExample = JSON.stringify({
            schema: "finny.news.claims.v1",
            result: "OK",
            identity: {
              requested_symbol: workspaceContext?.requested_symbol ?? "BTC",
              requested_interval: workspaceContext?.requested_interval ?? "1d",
              requested_asset_class: workspaceContext?.requested_asset_class ?? "crypto",
              requested_algorithm_name: workspaceContext?.requested_algorithm_name ?? workspace,
            },
            retrieved_at: "ISO-8601 retrieval timestamp",
            claims: [
              {
                class: "sourced_fact",
                statement: "Source-backed fact",
                source_url: "https://primary-or-major-source.example/item",
                provider: "source name",
                published_at: "ISO-8601 publication timestamp",
                retrieved_at: "ISO-8601 retrieval timestamp",
                excerpt: "Short supporting excerpt",
              },
            ],
          })
          const correction = yield* ops.resolvePromptParts(
            [
              "<news-evidence-correction>",
              "Your prior result could not be admitted because its finny.news.claims.v1 fenced JSON block was missing or malformed.",
              "Return one corrected final result now. Include a valid finny.news.claims.v1 block with complete request identity and provenance, fenced exactly as ```json followed by the JSON body and a closing ``` fence. Do not use ```finny.news.claims.v1 as the fence language.",
              `Use this exact top-level/container shape for an admissible sourced result: ${canonicalClaimsExample}`,
              'The evidence array must be named "claims" and each item must carry its class inside the array, for example "class":"sourced_fact"; do not use top-level sourced_facts or market_data_facts arrays.',
              "Use result OK only with at least one fully sourced sourced_fact or market_data_fact. Otherwise return an explicit NO_SOURCED_CONTEXT block with unavailable claims.",
              "This is the only automatic correction attempt; do not omit the machine-readable block.",
              "</news-evidence-correction>",
            ].join("\n"),
          )
          result = yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            ...(isFundRuntimeAgent(next.name)
              ? {}
              : {
                  model: {
                    modelID: model.modelID,
                    providerID: model.providerID,
                  },
                  variant: next.model ? undefined : variant,
                }),
            agent: next.name,
            parts: correction,
          })
          text = finalTaskText(result.parts)
          validated = validateNewsAgentTaskText({
            text,
            workspaceSlug: workspace,
            context: workspaceContext,
          })
        }
        if (params.subagent_type === "news_agent" && validated.ok) {
          verifiedNewsEvidence = { text: validated.text, issues: validated.issues }
        }
        if (!workspace) return validated.text
        const pointer = yield* Effect.promise(() => renderSubagentArtifactPointer(params.subagent_type, workspace))
        return pointer ? `${validated.text}\n\n${pointer}` : validated.text
      }
      if (params.subagent_type === "sec_agent" && workspace) {
        const pointer = yield* Effect.promise(() => renderSubagentArtifactPointer("sec_agent", workspace))
        return finalSpecialistTaskText({ subagentType: "sec_agent", text, pointer })
      }
      if (params.subagent_type === "sentiment_agent" && workspace) {
        const pointer = yield* Effect.promise(() => renderSubagentArtifactPointer("sentiment_agent", workspace))
        return finalSpecialistTaskText({ subagentType: "sentiment_agent", text, pointer })
      }
      if (params.subagent_type !== "data_extractor") return text
      const validateCurrentEvidence = Effect.fn("TaskTool.validateCurrentDataEvidence")(function* (
        candidateText: string,
      ) {
        const candidate = yield* Effect.promise(() =>
          validateDataExtractorTaskText({
            text: candidateText,
            workspaceSlug: workspace,
            context: validationContext,
          }),
        )
        if (candidate.ok) return candidate
        const existing = yield* Effect.promise(() =>
          validateExistingDataExtractorEvidence({
            workspaceSlug: workspace,
            context: validationContext,
            requestedProvider: explicitlyRequestedDataProvider(params.prompt),
          }),
        )
        return existing.found && existing.result ? existing.result : candidate
      })

      let validated = yield* validateCurrentEvidence(text)
      for (let attempt = 0; attempt < DATA_EXTRACTOR_REPAIR_ATTEMPTS && validated.partialEvidence; attempt++) {
        const repair = yield* ops.resolvePromptParts(dataExtractorRepairInstruction(validated.partialEvidence))
        result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          ...(isFundRuntimeAgent(next.name)
            ? {}
            : {
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                variant: next.model ? undefined : variant,
              }),
          agent: next.name,
          parts: repair,
        })
        text = finalTaskText(result.parts)
        validated = yield* validateCurrentEvidence(text)
      }
      if (validated.partialEvidence) return renderPartialDataExtractorHandoff(validated.partialEvidence)
      return validated.text
    })

    const trackedRun = Effect.fn("TaskTool.trackedRun")(function* () {
      if (scriptedHarness) return yield* runTask()
      const markRunningExit = yield* Effect.exit(Effect.promise(() => TaskState.markRunning(nextSession.id, database)))
      if (Exit.isFailure(markRunningExit)) return taskRegistryErrorText(Cause.squash(markRunningExit.cause))
      const exit = yield* Effect.exit(runTask())
      if (Exit.isSuccess(exit)) {
        const text = exit.value
        const status = taskResultStatus(text)
        if (params.subagent_type === "data_extractor" && status === TaskState.Status.completed) {
          const evidence = yield* Effect.promise(() => requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID))
          if (evidence.ok) {
            yield* recordVerifiedMarketDataSet({ sessionId: ctx.sessionID, datasets: evidence.datasets }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.asVoid,
            )
          }
        }
        if (
          params.subagent_type === "news_agent" &&
          status === TaskState.Status.completed &&
          verifiedNewsEvidence
        ) {
          yield* recordVerifiedNewsEvidence({
            sessionId: ctx.sessionID,
            sourceSessionId: nextSession.id,
            artifactText: verifiedNewsEvidence.text,
            issues: verifiedNewsEvidence.issues,
          }).pipe(Effect.provideService(Database.Service, database), Effect.asVoid)
        }
        const specialistKind =
          params.subagent_type === "sec_agent"
            ? ("sec" as const)
            : params.subagent_type === "sentiment_agent"
              ? ("sentiment" as const)
              : undefined
        if (
          specialistKind &&
          status === TaskState.Status.completed &&
          workspace === activeWorkflow?.workspaceSlug &&
          text.includes(`<subagent-artifact agent="${params.subagent_type}">`)
        ) {
          yield* recordVerifiedSpecialistEvidence({
            sessionId: ctx.sessionID,
            sourceSessionId: nextSession.id,
            kind: specialistKind,
            artifactText: text,
          }).pipe(Effect.provideService(Database.Service, database), Effect.asVoid)
        }
        if (workflowProjection) {
          yield* workflow.finishEvidence({
            sessionID: ctx.sessionID,
            workflowRunID,
            fingerprint: workflowProjection.fingerprint,
            status,
            output: text,
          })
          yield* recordDurableFinish(status, text)
          if (status === TaskState.Status.blocked) yield* cancelSiblingTasks()
        }
        return text
      }
      const error = Cause.squash(exit.cause)
      const status = Cause.hasInterruptsOnly(exit.cause) ? TaskState.Status.cancelled : TaskState.Status.failed
      if (workflowProjection) {
        yield* workflow.finishEvidence({
          sessionID: ctx.sessionID,
          workflowRunID,
          fingerprint: workflowProjection.fingerprint,
          status,
          output: error instanceof Error ? error.message : String(error),
        })
        yield* recordDurableFinish(status, error instanceof Error ? error.message : String(error))
        yield* cancelSiblingTasks()
      }
      return yield* Effect.failCause(exit.cause)
    })

    const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (state: "completed" | "error", text: string) {
      const input: SessionPrompt.PromptInput = {
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        variant,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: renderOutput({
              sessionID: nextSession.id,
              state,
              summary:
                state === "completed"
                  ? `Background task completed: ${params.description}`
                  : `Background task failed: ${params.description}`,
              text,
            }),
          },
        ],
      }
      const waitForParentIdle = Effect.fn("TaskTool.waitForParentIdle")(function* () {
        // A parent turn can legitimately remain busy for minutes while its
        // background children finish. Keep the retry interval bounded, but do
        // not impose a short total deadline that can strand a completed child
        // in the running state. The notification fiber is scope-bound, so this
        // wait remains cancellation-aware during shutdown.
        while (Option.isSome(sessionStatus) && (yield* sessionStatus.value.get(ctx.sessionID)).type !== "idle") {
          yield* Effect.sleep("100 millis")
        }
      })
      const deliver = (): Effect.Effect<boolean> =>
        waitForParentIdle().pipe(
          // A foreground strategy-context wait may have consumed and
          // terminalized this result while the notifier was waiting for the
          // parent to become idle. Re-check at the delivery boundary so the
          // same result cannot trigger a second synthesis turn.
          Effect.andThen(
            Effect.promise(() => TaskState.get(nextSession.id, database)).pipe(
              Effect.flatMap((task) => {
                if (task && TaskState.isTerminal(task.status)) return Effect.succeed(false)
                // Construct the prompt effect only after readiness, because
                // custom prompt adapters may perform bookkeeping when invoked.
                return Effect.suspend(() => ops.prompt(input)).pipe(Effect.as(true))
              }),
            ),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            // Status can race from idle back to busy between the readiness
            // check and prompt admission. Re-enter the readiness wait instead
            // of consuming a fixed one-second retry budget.
            if (isBusyError(error)) return Effect.sleep("100 millis").pipe(Effect.andThen(deliver()))
            if (Cause.hasInterruptsOnly(cause)) return Effect.succeed(false)
            return Effect.logError("background task result delivery failed", {
              "session.id": ctx.sessionID,
              "task.session.id": nextSession.id,
              state,
              error,
            }).pipe(Effect.as(false))
          }),
        )
      return yield* deliver()
    })

    const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
      yield* background.wait({ id: jobID }).pipe(
        Effect.flatMap((result) => {
          if (result.info?.status === "completed") {
            const text = result.info.output ?? EMPTY_SUBAGENT_RESULT_MARKER
            return Effect.gen(function* () {
              if (!(yield* inject("completed", text))) return
              const exit = yield* Effect.exit(
                Effect.promise(() =>
                  TaskState.finalizeActive(
                    nextSession.id,
                    {
                      status: taskResultStatus(text),
                      resultSummary: summarizeTaskResult(text),
                      lastError: null,
                    },
                    database,
                  ),
                ),
              )
              if (Exit.isFailure(exit)) {
                yield* inject("error", taskRegistryErrorText(Cause.squash(exit.cause)))
              }
            })
          }
          if (result.info?.status === "error") {
            const error = result.info.error ?? ""
            return Effect.gen(function* () {
              if (!(yield* inject("error", error))) return
              const exit = yield* Effect.exit(
                Effect.promise(() =>
                  TaskState.finalizeActive(
                    nextSession.id,
                    {
                      status: TaskState.Status.failed,
                      lastError: error,
                    },
                    database,
                  ),
                ),
              )
              if (Exit.isFailure(exit)) {
                yield* inject("error", taskRegistryErrorText(Cause.squash(exit.cause)))
              }
            })
          }
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
      return {
        title: params.description,
        metadata: {
          ...metadata,
          background: true,
          jobId: nextSession.id,
        },
        output: renderOutput({
          sessionID: nextSession.id,
          state: "running",
          summary: "Background task updated",
          text: BACKGROUND_UPDATED,
        }),
      }
    }

    const info = yield* background.start({
      id: nextSession.id,
      type: permission,
      title: params.description,
      metadata,
      onPromote: Effect.all(
        [
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ],
        { discard: true },
      ),
      run: trackedRun().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
    })

    function backgroundResult() {
      return {
        title: params.description,
        metadata: {
          ...metadata,
          background: true,
          jobId: info.id,
        },
        output: renderOutput({
          sessionID: nextSession.id,
          state: "running",
          summary: "Background task started",
          text: BACKGROUND_STARTED,
        }),
      }
    }

    if (runInBackground) {
      yield* notify(info.id)
      return backgroundResult()
    }

    const runCancel = yield* EffectBridge.make()
    const cancel = ops.cancel(nextSession.id)

    function onAbort() {
      runCancel.fork(cancel)
    }

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        ctx.abort.addEventListener("abort", onAbort)
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* Effect.raceFirst(
            background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
            background.waitForPromotion(nextSession.id),
          )
          if (result?.metadata?.background === true) return backgroundResult()
          if (result?.status === "error" || result?.status === "cancelled") {
            const error = result.status === "error" ? (result.error ?? "Task failed") : "Task cancelled"
            yield* Effect.promise(() =>
              TaskState.finalizeActive(
                nextSession.id,
                {
                  status: result.status === "error" ? TaskState.Status.failed : TaskState.Status.cancelled,
                  lastError: error,
                },
                database,
              ),
            )
            return yield* Effect.fail(new Error(error))
          }
          const text = result?.output ?? EMPTY_SUBAGENT_RESULT_MARKER
          yield* Effect.promise(() =>
            TaskState.finalizeActive(
              nextSession.id,
              {
                status: taskResultStatus(text),
                resultSummary: summarizeTaskResult(text),
                lastError: null,
              },
              database,
            ),
          )
          return {
            title: params.description,
            metadata,
            output: renderOutput({
              sessionID: nextSession.id,
              state: "completed",
              text,
            }),
          }
        }),
      (_, exit) =>
        Effect.gen(function* () {
          if (Exit.hasInterrupts(exit))
            yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", onAbort)
            }),
          ),
        ),
    )
  })

  const runBatch = Effect.fn("TaskTool.executeBatch")(function* (params: TaskBatchRunParameters, ctx: Tool.Context) {
    const subagentTypes = params.tasks.map((task) => task.subagent_type)
    if (new Set(subagentTypes).size !== subagentTypes.length) {
      return yield* Effect.fail(new Error("Task batch mode requires distinct subagent types"))
    }

    const activeWorkflow = yield* activeWorkflowForSession(ctx.sessionID).pipe(
      Effect.provideService(Database.Service, database),
    )
    if (activeWorkflow && BuildWorkflow.isBuildAgent(ctx.agent)) {
      const launchBlock = StrategyContext.requiredContextLaunchBlock({
        workflow: activeWorkflow,
        tasks: yield* Effect.promise(() => StrategyContext.contextTasks(ctx.sessionID, database)),
        requestedRoles: subagentTypes,
        batch: true,
      })
      if (launchBlock) {
        return {
          title: "Strategy-context kickoff incomplete",
          metadata: { parentSessionId: ctx.sessionID } as TaskMetadata,
          output: launchBlock,
        }
      }
    }

    const existingWorkspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
    if (
      !existingWorkspace &&
      subagentTypes.some((type) =>
        ["data_extractor", "news_agent", "researcher", "sec_agent", "sentiment_agent"].includes(type),
      )
    ) {
      const bootstrapped = yield* Effect.promise(() =>
        bootstrapWorkspace(ctx.sessionID, params.tasks.map((task) => task.prompt).join("\n\n")).catch(() => undefined),
      )
      if (bootstrapped?.slug) {
        yield* Effect.promise(() => bindSessionWorkspace(ctx.sessionID, bootstrapped.slug).catch(() => {}))
      }
    }

    // Establish one immutable parent request context before background
    // children start. Letting each child rewrite the shared request spec
    // races the atomic writer and can make sibling evidence agents appear to
    // belong to different symbols.
    const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
    const parentFacts = yield* Effect.promise(() => readRuntimeRequestFacts(ctx.sessionID))
    const canonicalTask = params.tasks.find((task) => task.subagent_type === "data_extractor") ?? params.tasks[0]
    if (workspace && canonicalTask && !requestHasIdentity(parentFacts)) {
      yield* Effect.promise(() =>
        syncWorkspaceRequestContext({
          sessionID: ctx.sessionID,
          slug: workspace,
          prompt: canonicalTask.prompt,
          actor: "runtime",
          reason: "batch evidence request context",
        }),
      )
    }

    const runningSubagents = new Map<string, NonNullable<TaskMetadata["subagents"]>[number]>()
    const batchMetadata = (subagents: NonNullable<TaskMetadata["subagents"]>): TaskMetadata =>
      ({
        parentSessionId: ctx.sessionID,
        batch: true,
        taskCount: params.tasks.length,
        subagentTypes,
        subagents,
      }) as TaskMetadata
    const updateRunningBatch =
      (task: TaskBatchRunParameters["tasks"][number]) => (val: { title?: string; metadata?: TaskMetadata }) =>
        Effect.gen(function* () {
          const sessionId = val.metadata?.sessionId
          if (!sessionId) return
          runningSubagents.set(sessionId, {
            sessionId,
            subagentType: task.subagent_type,
            description: task.description,
            state: "running",
          })
          yield* ctx.metadata({
            title: "Mandatory evidence batch",
            metadata: batchMetadata([...runningSubagents.values()]),
          })
        })

    const exits = yield* Effect.all(
      params.tasks.map((task) =>
        Effect.exit(
          runSingle(
            task,
            {
              ...ctx,
              metadata: updateRunningBatch(task),
            },
            { mode: "foreground", batch: true },
          ),
        ),
      ),
      // Serialize only the deterministic fixture's fresh-database startup.
      {
        concurrency:
          process.env.FINNY_HARNESS_MODE === "1" && process.env.FINNY_HARNESS_SCRIPTED_MODEL === "1" ? 1 : "unbounded",
      },
    )
    const results = exits.map((exit, index) => {
      const task = params.tasks[index]
      if (Exit.isSuccess(exit)) {
        const state = exit.value.metadata.background === true ? ("running" as const) : ("completed" as const)
        return {
          index,
          subagentType: task.subagent_type,
          description: task.description,
          sessionId: exit.value.metadata.sessionId,
          state,
          text: exit.value.output,
        }
      }
      const error = Cause.squash(exit.cause)
      return {
        index,
        subagentType: task.subagent_type,
        description: task.description,
        sessionId: undefined,
        state: "error" as const,
        text: `<task_error>${error instanceof Error ? error.message : String(error)}</task_error>`,
      }
    })
    const childSubagents = results.flatMap((result) =>
      result.sessionId
        ? [
            {
              sessionId: result.sessionId,
              subagentType: result.subagentType,
              description: result.description,
              state: result.state,
            },
          ]
        : [],
    )
    return {
      title: "Mandatory evidence batch",
      metadata: {
        ...batchMetadata(childSubagents),
        ...(childSubagents[0] ? { sessionId: childSubagents[0].sessionId } : {}),
      } as TaskMetadata,
      output: renderBatchOutput(results),
    }
  })

  return { runSingle, runBatch }
})

export const TaskStartTool = Tool.define(
  "task_start",
  Effect.gen(function* () {
    const executor = yield* taskExecutor
    return {
      description: TASK_START_DESCRIPTION,
      parameters: TaskStartParameters,
      jsonSchema: closedJsonSchema(TaskStartParameters),
      parseOptions: { onExcessProperty: "error" },
      execute: (params: TaskStartParameters, ctx: Tool.Context) =>
        executor.runSingle(params, ctx, { mode: "background" }).pipe(Effect.orDie),
    }
  }),
)

export const TaskRunTool = Tool.define(
  "task_run",
  Effect.gen(function* () {
    const executor = yield* taskExecutor
    return {
      description: TASK_RUN_DESCRIPTION,
      parameters: TaskRunParameters,
      jsonSchema: closedJsonSchema(TaskRunParameters),
      parseOptions: { onExcessProperty: "error" },
      execute: (params: TaskRunParameters, ctx: Tool.Context) =>
        executor.runSingle(params, ctx, { mode: "foreground" }).pipe(Effect.orDie),
    }
  }),
)

export const TaskBatchRunTool = Tool.define(
  "task_batch_run",
  Effect.gen(function* () {
    const executor = yield* taskExecutor
    return {
      description: TASK_BATCH_RUN_DESCRIPTION,
      parameters: TaskBatchRunParameters,
      jsonSchema: closedJsonSchema(TaskBatchRunParameters, "tasks"),
      parseOptions: { onExcessProperty: "error" },
      execute: (params: TaskBatchRunParameters, ctx: Tool.Context) => executor.runBatch(params, ctx).pipe(Effect.orDie),
    }
  }),
)

/** Internal subtask execution is synchronous and uses the same contract as task_run. */
export const TaskTool = TaskRunTool
