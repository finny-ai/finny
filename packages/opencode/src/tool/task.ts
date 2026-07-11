import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { algoDir, bindSessionWorkspace, getSessionWorkspace, humanNameOf } from "@finny-ai/core/algo"
import fs from "fs/promises"
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
  syncWorkspaceRequestContext,
  type WorkspaceRequestContext,
} from "@/agent/finny-workspace-context"
import { bootstrapWorkspace } from "@/plugin/finny-workspace"
import { validateDataExtractorTaskText, validateExistingDataExtractorEvidence } from "@/data/data-extractor-evidence"
import { validateNewsAgentTaskText } from "@/data/news-evidence"
import { parseSecRequestContext } from "@/data/sec-edgar"
import { renderSubagentArtifactPointer } from "@/agent/subagent-artifact"
import { TaskState } from "@/task/state"

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

export { validateDataExtractorTaskText }

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode launches a subagent asynchronously and returns immediately.",
  "Finny launches single subagent tasks in the background by default.",
  "Use foreground only for independent batch work that must return all results before continuing.",
  "You will be notified automatically when it finishes.",
].join(" ")
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

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Session.BusyError ||
    (typeof error === "object" && error !== null && (error as any)._tag === "SessionBusyError")
  )
}

function field(label: string, value: string | undefined) {
  return `- ${label}: ${value ?? "MISSING"}`
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

async function readWorkspaceDateWindow(workspace: string | null): Promise<{
  requested_start?: string
  requested_end?: string
  requested_interval?: string
}> {
  if (!workspace) return {}
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(algoDir(workspace), "request.json"), "utf8"))
    return {
      requested_start: typeof parsed.requested_start === "string" ? parsed.requested_start : undefined,
      requested_end: typeof parsed.requested_end === "string" ? parsed.requested_end : undefined,
      requested_interval: typeof parsed.requested_interval === "string" ? parsed.requested_interval : undefined,
    }
  } catch {
    return {}
  }
}

function unapprovedExtendedDataWindowBlock(input: {
  prompt: string
  workspace: string | null
  existing: { requested_start?: string; requested_end?: string; requested_interval?: string }
}): string | undefined {
  if (input.existing.requested_start && input.existing.requested_end) return undefined

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
  const symbol = requestedSymbols?.length ? requestedSymbols.join(",") : (normalizeSymbol(facts.requested_symbol) ?? "?")
  const interval = normalizeInterval(facts.requested_interval) ?? "?"
  const assetClass = facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol ?? requestedSymbols?.[0]) ?? "?"
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
  const workspaceFacts = parseRequestFacts(workspace)
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

async function readWorkspaceRequestFacts(workspace: string | null): Promise<RequestFacts> {
  if (!workspace) return {}
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(algoDir(workspace), "request.json"), "utf8"))
    return {
      requested_symbol: typeof parsed.requested_symbol === "string" ? parsed.requested_symbol : undefined,
      requested_symbols: Array.isArray(parsed.requested_symbols)
        ? parsed.requested_symbols.filter((value: unknown): value is string => typeof value === "string")
        : undefined,
      requested_interval: typeof parsed.requested_interval === "string" ? parsed.requested_interval : undefined,
      requested_asset_class:
        parsed.requested_asset_class === "crypto" || parsed.requested_asset_class === "equity"
          ? parsed.requested_asset_class
          : undefined,
      requested_algorithm_name:
        typeof parsed.requested_algorithm_name === "string" ? parsed.requested_algorithm_name : undefined,
    }
  } catch {
    return {}
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

function withFinnySubagentContext(
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
      "Use retrieval_time_utc as retrieved_at on sourced_fact claims. Never set published_at after retrieved_at.",
      "Future event_time is allowed for scheduled catalysts when published_at is valid.",
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
    params.subagent_type === "data_extractor" ? childSymbolWithinContextUniverse(facts.requested_symbol, context) : undefined
  const window = extractDateWindow(prompt)
  const inferred = inferBacktestWindow(prompt)
  const symbol = childSymbol ?? context?.requested_symbol ?? facts.requested_symbol
  const symbolsOrUniverse = childSymbol ?? context?.requested_symbols?.join(", ") ?? facts.requested_symbols?.join(", ") ?? symbol
  const interval = context?.requested_interval ?? facts.requested_interval
  const assetClass =
    context?.requested_asset_class ??
    facts.requested_asset_class ??
    assetClassForSymbol(symbol ?? facts.requested_symbols?.[0])
  const algorithmName =
    context?.requested_algorithm_name ?? facts.requested_algorithm_name ?? algorithmNameFromWorkspaceSlug(workspace)
  const dataWindow = completedIntradayWindow({
    start: context?.requested_start ?? window.start ?? inferred.start,
    end: context?.requested_end ?? window.end ?? inferred.end,
    interval,
  })

  if (params.subagent_type === "data_extractor") {
    return [
      "<finny-subagent-context>",
      "Authoritative runtime context. It overrides conflicting task wording.",
      "Data request context:",
      field("workspace_slug", workspace),
      field("requested_algorithm_name", algorithmName),
      field("symbols or universe", symbolsOrUniverse),
      field("interval", interval),
      field("start date as absolute YYYY-MM-DD", dataWindow.start),
      field("end date as absolute YYYY-MM-DD", dataWindow.end),
      field("asset_class when known", assetClass),
      field("mission_path when known", path.join(workspacePath, "mission.md")),
      field("allowed_data_dir when known", dataDir),
      "- cookbook_path: data-agent/instructions.md",
      "- provider_skill_policy: after selecting a provider, load the matching provider skill before the first provider fetch when available.",
      "- provider_skill_map: binance=finny-provider-binance; polygon/massive=finny-provider-polygon; yfinance/yahoo=finny-provider-yfinance.",
      "- end_date_semantics: the end date is INCLUSIVE; its bars are part of the window. Provider end/endTime params are timestamp bounds, so pass end date + 1 day as the fetch bound (e.g. end 2026-07-02 -> end=2026-07-03T00:00:00Z for Alpaca/yfinance/Binance; Polygon /range/ is date-inclusive, pass as-is). Passing the bare end date drops the final session and falsely reads as partial coverage.",
      dataWindow.adjusted
        ? "- window_adjustment: intraday rolling window capped at the last fully completed UTC date; do not require future bars from the current UTC day."
        : undefined,
      "",
      "Use `data-agent/instructions.md` as the source cookbook. Do not read `algos/_template/README.md`; it is outside the Data Agent read contract.",
      "Set bash `workdir` to `allowed_data_dir` for writes. Manifests must record requested_start/requested_end separately from actual_start/actual_end computed from saved rows.",
      "</finny-subagent-context>",
      "",
      prompt,
    ].join("\n")
  }

  if (params.subagent_type === "sec_agent") {
    const secDir = path.join(dataDir, "sec")
    const secContext = parseSecRequestContext(prompt)
    return [
      "<finny-subagent-context>",
      "Authoritative runtime context. It overrides conflicting task wording.",
      "SEC EDGAR request context:",
      field("workspace_slug", workspace),
      field("workspace_name", humanNameOf(workspace)),
      field("requested_company_or_ticker", secContext.requested_company_or_ticker ?? symbolsOrUniverse),
      field("resolved_symbol when known", secContext.resolved_symbol ?? symbolsOrUniverse),
      field("resolved_cik when known", secContext.resolved_cik),
      field("requested_person", secContext.requested_person),
      field("requested_institution", secContext.requested_institution),
      field("date window start as YYYY-MM-DD", secContext.date_start ?? context?.requested_start ?? window.start),
      field("date window end as YYYY-MM-DD", secContext.date_end ?? context?.requested_end ?? window.end),
      field("allowed_sec_dir", secDir),
      field("analysis_intent", secContext.analysis_intent ?? prompt.slice(0, 240)),
      "",
      "Write durable SEC artifacts only under `allowed_sec_dir`. Return `BLOCKED:` when company/person/date scope cannot be resolved.",
      "Every artifact must record SEC URL, accession number, form type, filing date, CIK, and extraction timestamp.",
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
      "Authoritative runtime context. It overrides conflicting task wording.",
      "Social sentiment request context:",
      field("workspace_slug", workspace),
      field("workspace_name", humanNameOf(workspace)),
      field("requested_algorithm_name", algorithmName),
      field("requested_symbol", symbolsOrUniverse),
      field("requested_interval", interval),
      field("requested_asset_class", assetClass),
      field("date window start as absolute YYYY-MM-DD", dataWindow.start),
      field("date window end as absolute YYYY-MM-DD", dataWindow.end),
      field("allowed_sentiment_dir", sentimentDir),
      field("expected_sentiment_csv_path", expectedSentimentCsvPath),
      field("expected_sentiment_manifest_path", expectedSentimentManifestPath),
      dataWindow.adjusted
        ? "- window_adjustment: intraday rolling window capped at the last fully completed UTC date; do not require future social data from the current UTC day."
        : undefined,
      "",
      "When useful evidence is available, write the aggregate CSV exactly to `expected_sentiment_csv_path` and the manifest exactly to `expected_sentiment_manifest_path`.",
      "Do not use alternate names such as `aggregate.csv`, `manifest.json`, dated snapshots, lowercase symbols, or source-specific filenames.",
      "Write aggregate CSV and manifest artifacts directly under `allowed_sentiment_dir`. Do not create or write nested `body/` or `headlines/` folders.",
      "Raw social post/comment text must remain transient and must not be persisted, even if the user asks for local-only storage.",
      "Return artifact_paths that point to files directly under `allowed_sentiment_dir`.",
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
    field("workspace_name", humanNameOf(workspace)),
    field("requested_algorithm_name", context?.requested_algorithm_name ?? facts.requested_algorithm_name),
    field("requested_symbol", symbolsOrUniverse),
    field("requested_interval", interval),
    field("requested_asset_class", assetClass),
    field("workspace_news_dir", newsDir),
    field("retrieval_time_utc", retrievalTimeUtc),
    "",
    "Write at most one compact news/execution/provenance/risk markdown note directly under `workspace_news_dir`. Do not create nested `body/` or `headlines/` folders.",
    "Do not write to `algos/_template/data/news` or any repo-local `algos/*/data/news` path.",
    "Return artifact_paths that point to files under `workspace_news_dir`.",
    "Every written note and the returned brief MUST include a fenced finny.news.claims.v1 JSON claims block.",
    "Only sourced_fact and market_data_fact with complete provenance count as evidence. model_hypothesis is never evidence.",
    "If no source class yields a sourced fact, return NO_SOURCED_CONTEXT with attempted sources and failure reasons — do not synthesize a market-context brief from general knowledge.",
    "Use retrieval_time_utc as retrieved_at on sourced_fact claims. Never set published_at after retrieved_at (temporal leakage).",
    "Future event_time is allowed for scheduled catalysts (earnings, FOMC, rebalances) when published_at is at or before retrieved_at.",
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
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const SingleParameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const BatchTaskParameters = Schema.Struct({
  description: BaseParameterFields.description,
  prompt: BaseParameterFields.prompt,
  subagent_type: BaseParameterFields.subagent_type,
  command: BaseParameterFields.command,
})

const BatchParameters = Schema.Struct({
  tasks: Schema.Array(BatchTaskParameters).annotate({
    description:
      "Two or three independent foreground subagents to launch together. All results are returned, including BLOCKED results.",
  }),
})

export const Parameters = Schema.Union([SingleParameters, BatchParameters])

type TaskParameters = Schema.Schema.Type<typeof Parameters>
type SingleTaskParameters = Exclude<TaskParameters, { tasks: ReadonlyArray<unknown> }>

function taskJsonSchema(): JSONSchema7 {
  const single = ToolJsonSchema.fromSchema(SingleParameters)
  const batch = ToolJsonSchema.fromSchema(BatchParameters)
  return {
    type: "object",
    properties: {
      ...(single.properties ?? {}),
      ...(batch.properties ?? {}),
    },
    anyOf: [{ required: ["description", "prompt", "subagent_type"] }, { required: ["tasks"] }],
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

function isBatchParameters(
  params: TaskParameters,
): params is Extract<TaskParameters, { tasks: ReadonlyArray<unknown> }> {
  return "tasks" in params
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
    state: "completed" | "error"
    text: string
  }>,
) {
  return [
    '<task_batch state="completed">',
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

export function taskRegistryErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return [
    "BLOCKED: internal task registry error.",
    "The subagent did not launch because Finny could not record its task lifecycle.",
    `Registry error: ${message.slice(0, 500)}`,
    "Restart Finny with the latest build and let migrations run before retrying. Do not retry this task until the registry is healthy.",
  ].join(" ")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    const runSingle = Effect.fn("TaskTool.executeSingle")(function* (
      params: SingleTaskParameters,
      ctx: Tool.Context,
      options?: { forceForeground?: boolean },
    ) {
      const cfg = yield* config.get()
      const runInBackground = options?.forceForeground === true ? false : ctx.agent === "finny" || params.background === true

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
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

      // Subagents inherit the parent session's algo workspace binding so data
      // extraction and research notes land in the same per-request workspace.
      const workspaceState = yield* Effect.promise(async () => {
        const parentWorkspace = await getSessionWorkspace(ctx.sessionID).catch(() => null)
        const childWorkspace = await getSessionWorkspace(nextSession.id).catch(() => null)
        const promptFacts = parseRequestFacts(params.prompt)
        const parentFacts = await readWorkspaceRequestFacts(parentWorkspace)
        const inParentUniverse = finnySubagentType(params.subagent_type)
          ? childSymbolWithinRequestUniverse(promptFacts.requested_symbol, parentFacts)
          : undefined
        const parentConflict = finnySubagentType(params.subagent_type) && parentFacts.requested_symbols?.length
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
          !promptFacts.requested_symbols?.length
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
          parentWorkspace && inParentUniverse
            ? parentWorkspace
            : workspaceMatchesPromptFacts(parentWorkspace, promptFacts)
              ? parentWorkspace
              : workspaceMatchesPromptFacts(childWorkspace, promptFacts)
                ? childWorkspace
                : null
        const useParentContext = Boolean(
          parentWorkspace && workspace === parentWorkspace && requestHasIdentity(parentFacts),
        )
        if (finnySubagentType(params.subagent_type) && (!workspace || (requestHasIdentity(promptFacts) && !useParentContext))) {
          workspace = (await bootstrapWorkspace(ctx.sessionID, params.prompt).catch(() => undefined))?.slug ?? workspace
        }
        if (workspace) {
          await bindSessionWorkspace(ctx.sessionID, workspace).catch(() => {})
          await bindSessionWorkspace(nextSession.id, workspace).catch(() => {})
        }
        return {
          slug: workspace,
          preserveExistingContext: Boolean(parentWorkspace && workspace === parentWorkspace && requestHasIdentity(parentFacts)),
        }
      })
      const workspace = workspaceState.slug

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
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
        process.env.FINNY_HARNESS_MODE === "1" && process.env.FINNY_HARNESS_SCRIPTED_MODEL === "1"
      const registryExit = scriptedHarness
        ? Exit.succeed(undefined)
        : yield* Effect.exit(
            Effect.promise(async () => {
              const existingTask = await TaskState.get(nextSession.id)
              if (!existingTask) {
                await TaskState.upsert({
                  id: nextSession.id,
                  parentSessionID: ctx.sessionID,
                  description: params.description,
                  subagentType: params.subagent_type,
                  mode,
                  status: TaskState.Status.queued,
                })
              }
            }),
          )
      if (Exit.isFailure(registryExit)) {
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

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        if (workspaceState.blocked) return workspaceState.blocked
        if (params.subagent_type === "data_extractor" && !workspace) {
          return "BLOCKED: incomplete data request context: missing workspace_slug, allowed_data_dir"
        }
        if (params.subagent_type === "data_extractor") {
          const existingWindow = yield* Effect.promise(() => readWorkspaceDateWindow(workspace))
          const dateBlock = unapprovedExtendedDataWindowBlock({
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
          workspaceContext = yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: ctx.sessionID,
              slug: workspace,
              prompt: params.prompt,
              preserveExisting: workspaceState.preserveExistingContext,
            }).catch(() => undefined),
          )
        }
        const validationContext =
          params.subagent_type === "data_extractor"
            ? dataExtractorValidationContext(workspaceContext, parseRequestFacts(params.prompt))
            : workspaceContext
        if (params.subagent_type === "data_extractor") {
          const mismatch = dataRequestContextMismatchBlock({ prompt: params.prompt, workspace, context: workspaceContext })
          if (mismatch) return mismatch
          const existing = yield* Effect.promise(() =>
            validateExistingDataExtractorEvidence({
              workspaceSlug: workspace,
              context: validationContext,
            }),
          )
          if (existing.found && existing.result?.ok) return existing.result.text
        }
        const parts = yield* ops.resolvePromptParts(
          withFinnySubagentContext(params, params.prompt, workspace, workspaceContext),
        )
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        const text = finalTaskText(result.parts)
        if (params.subagent_type === "news_agent" || params.subagent_type === "researcher") {
          const validated = validateNewsAgentTaskText({
            text,
            workspaceSlug: workspace,
            context: workspaceContext,
          }).text
          if (!workspace) return validated
          const pointer = yield* Effect.promise(() =>
            renderSubagentArtifactPointer(params.subagent_type, workspace),
          )
          return pointer ? `${validated}\n\n${pointer}` : validated
        }
        if (params.subagent_type === "sec_agent" && workspace) {
          const pointer = yield* Effect.promise(() => renderSubagentArtifactPointer("sec_agent", workspace))
          return pointer ? `${text}\n\n${pointer}` : text
        }
        if (params.subagent_type !== "data_extractor") return text
        const validated = yield* Effect.promise(() =>
          validateDataExtractorTaskText({
            text,
            workspaceSlug: workspace,
            context: validationContext,
          }),
        )
        if (!validated.ok) {
          const existing = yield* Effect.promise(() =>
            validateExistingDataExtractorEvidence({
              workspaceSlug: workspace,
              context: validationContext,
            }),
          )
          if (existing.found && existing.result?.ok) return existing.result.text
        }
        return validated.text
      })

      const trackedRun = Effect.fn("TaskTool.trackedRun")(function* () {
        if (scriptedHarness) return yield* runTask()
        const markRunningExit = yield* Effect.exit(Effect.promise(() => TaskState.markRunning(nextSession.id)))
        if (Exit.isFailure(markRunningExit)) return taskRegistryErrorText(Cause.squash(markRunningExit.cause))
        const exit = yield* Effect.exit(runTask())
        if (Exit.isSuccess(exit)) {
          const text = exit.value
          const finalizeExit = yield* Effect.exit(
            Effect.promise(() =>
              TaskState.finalizeActive(nextSession.id, {
                status: taskResultStatus(text),
                resultSummary: summarizeTaskResult(text),
                lastError: null,
              }),
            ),
          )
          if (Exit.isFailure(finalizeExit)) return taskRegistryErrorText(Cause.squash(finalizeExit.cause))
          return text
        }
        const error = Cause.squash(exit.cause)
        const finalizeExit = yield* Effect.exit(
          Effect.promise(() =>
            TaskState.finalizeActive(nextSession.id, {
              status: Cause.hasInterruptsOnly(exit.cause) ? TaskState.Status.cancelled : TaskState.Status.failed,
              lastError: error instanceof Error ? error.message : String(error),
            }),
          ),
        )
        if (Exit.isFailure(finalizeExit)) return taskRegistryErrorText(Cause.squash(finalizeExit.cause))
        return yield* Effect.failCause(exit.cause)
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
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
        const deliver = (attempt: number): Effect.Effect<void> =>
          ops.prompt(input).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              if (isBusyError(error) && attempt < 10)
                return Effect.sleep("100 millis").pipe(Effect.andThen(deliver(attempt + 1)))
              if (Cause.hasInterruptsOnly(cause)) return Effect.void
              return Effect.logError("background task result delivery failed", {
                "session.id": ctx.sessionID,
                "task.session.id": nextSession.id,
                state,
                error,
              })
            }),
          )
        yield* deliver(0)
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") {
              const text = result.info.output ?? EMPTY_SUBAGENT_RESULT_MARKER
              return Effect.exit(
                Effect.promise(() =>
                  TaskState.finalizeActive(nextSession.id, {
                    status: taskResultStatus(text),
                    resultSummary: summarizeTaskResult(text),
                    lastError: null,
                  }),
                ),
              ).pipe(
                Effect.flatMap((exit) =>
                  inject(
                    "completed",
                    Exit.isFailure(exit) ? taskRegistryErrorText(Cause.squash(exit.cause)) : text,
                  ),
                ),
              )
            }
            if (result.info?.status === "error") {
              const error = result.info.error ?? ""
              return Effect.exit(
                Effect.promise(() =>
                  TaskState.finalizeActive(nextSession.id, {
                    status: TaskState.Status.failed,
                    lastError: error,
                  }),
                ),
              ).pipe(
                Effect.flatMap((exit) =>
                  inject("error", Exit.isFailure(exit) ? taskRegistryErrorText(Cause.squash(exit.cause)) : error),
                ),
              )
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
        type: id,
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
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? EMPTY_SUBAGENT_RESULT_MARKER,
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

    const run = Effect.fn("TaskTool.execute")(function* (params: TaskParameters, ctx: Tool.Context) {
      if (!isBatchParameters(params)) return yield* runSingle(params, ctx)

      if (params.tasks.length < 2 || params.tasks.length > 4) {
        return yield* Effect.fail(new Error("Task batch mode requires two to four foreground tasks"))
      }
      const subagentTypes = params.tasks.map((task) => task.subagent_type)
      if (new Set(subagentTypes).size !== subagentTypes.length) {
        return yield* Effect.fail(new Error("Task batch mode requires distinct subagent types"))
      }

      const existingWorkspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      if (
        !existingWorkspace &&
        subagentTypes.some((type) =>
          ["data_extractor", "news_agent", "researcher", "sec_agent", "sentiment_agent"].includes(type),
        )
      ) {
        const bootstrapped = yield* Effect.promise(() =>
          bootstrapWorkspace(ctx.sessionID, params.tasks.map((task) => task.prompt).join("\n\n")).catch(
            () => undefined,
          ),
        )
        if (bootstrapped?.slug) {
          yield* Effect.promise(() => bindSessionWorkspace(ctx.sessionID, bootstrapped.slug).catch(() => {}))
        }
      }

      const runningSubagents = new Map<
        string,
        NonNullable<TaskMetadata["subagents"]>[number]
      >()
      const batchMetadata = (subagents: NonNullable<TaskMetadata["subagents"]>): TaskMetadata => ({
        parentSessionId: ctx.sessionID,
        sessionId: ctx.sessionID,
        batch: true,
        taskCount: params.tasks.length,
        subagentTypes,
        subagents,
      })
      const updateRunningBatch = (task: Extract<TaskParameters, { tasks: ReadonlyArray<unknown> }>["tasks"][number]) =>
        (val: { title?: string; metadata?: TaskMetadata }) =>
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
              { forceForeground: true },
            ),
          ),
        ),
        // Serialize only the deterministic fixture's fresh-database startup.
        {
          concurrency:
            process.env.FINNY_HARNESS_MODE === "1" && process.env.FINNY_HARNESS_SCRIPTED_MODEL === "1"
              ? 1
              : "unbounded",
        },
      )
      const results = exits.map((exit, index) => {
        const task = params.tasks[index]
        if (Exit.isSuccess(exit)) {
          return {
            index,
            subagentType: task.subagent_type,
            description: task.description,
            sessionId: exit.value.metadata.sessionId,
            state: "completed" as const,
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
          sessionId: childSubagents[0]?.sessionId ?? ctx.sessionID,
        } satisfies TaskMetadata,
        output: renderBatchOutput(results),
      }
    })

    return {
      description: [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n"),
      parameters: Parameters,
      jsonSchema: taskJsonSchema(),
      execute: (params: TaskParameters, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
