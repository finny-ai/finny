import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { assetClassForSymbol, normalizeSymbol, parseRequestIdentityProposal } from "@/agent/request-identity"
import { inferBacktestWindow, writeWorkflowRequestProjection } from "@/agent/finny-workspace-context"
import { bootstrapWorkspace, deriveIntent } from "@/plugin/finny-workspace"
import { unambiguousApprovalDecision } from "./state"
import { BuildWorkflowStore } from "./store"
import type { BuildWorkflowState, FactSource, RequestIdentity, WorkflowEvent } from "./types"

const PRIMARY_BUILD_AGENTS = new Set(["finny", "build"])
const NEWS_CLAIM_RE =
  /\b(news|headlines?|catalysts?|earnings|macro\s+events?|market\s+regime|current(?:\s+market)?\s+regime|latest\s+(?:news|headlines?|catalysts?|market\s+regime)|today(?:'s)?\s+(?:news|headlines?|catalysts?|market\s+regime))\b/i
const SEC_CLAIM_RE = /\b(sec|filings?|10-[kq]|8-k|fundamentals?|ownership|insiders?|institutional\s+holdings?)\b/i
const SENTIMENT_CLAIM_RE = /\b(sentiment|social|crowding|crowded|reddit|twitter|x\.com|stocktwits)\b/i

export function workflowClaimFlags(prompt: string) {
  return {
    newsRequired: NEWS_CLAIM_RE.test(prompt),
    filingDependent: SEC_CLAIM_RE.test(prompt),
    sentimentRequired: SENTIMENT_CLAIM_RE.test(prompt),
  }
}

export function structuredWorkflowClaimFlags(prompt: string, vagueStrategyBuild = false) {
  const flags = workflowClaimFlags(prompt)
  return {
    ...flags,
    newsRequired: flags.newsRequired || vagueStrategyBuild,
  }
}

export function requiresIdentityClarification(prompt: string) {
  return parseRequestIdentityProposal(prompt).status === "proposed"
}

function workflowID(sessionID: string, messageID: string) {
  return `wf_${crypto.createHash("sha256").update(`${sessionID}:${messageID}`).digest("hex").slice(0, 32)}`
}

/**
 * Materialize the WorkflowRun that was intentionally deferred for a vague
 * opening request once finny_workspace_prepare has crossed the trusted
 * clarification boundary. The structured identity has already been checked
 * against the real user text/question answers by the tool before this runs.
 */
export const ensureStructuredBuildWorkflow = Effect.fn("BuildWorkflowBind.ensureStructured")(function* (input: {
  sessionID: string
  callID: string
  agent: string
  workspaceSlug: string
  prompt: string
  symbols: string[]
  assetClass?: "equity" | "crypto"
  interval?: string
  algorithmName?: string
  strategyFamily?: string
  vagueStrategyBuild?: boolean
  window?: { start: string; end: string }
}) {
  if (!PRIMARY_BUILD_AGENTS.has(input.agent)) return undefined
  const active = (yield* BuildWorkflowStore.listBySession(input.sessionID)).find(
    (state) => state.status === "active" || state.status === "blocked",
  )
  if (active) return active

  const symbols = input.symbols.map(normalizeSymbol).filter((symbol): symbol is string => Boolean(symbol))
  if (!symbols.length) return undefined
  const source: FactSource = {
    kind: "structured_tool",
    tool: "finny_workspace_prepare",
    callId: input.callID,
  }
  const flags = structuredWorkflowClaimFlags(input.prompt, input.vagueStrategyBuild)
  return yield* BuildWorkflowStore.insert({
    workflowId: workflowID(input.sessionID, `finny_workspace_prepare:${input.callID}`),
    sessionId: input.sessionID,
    workspaceSlug: input.workspaceSlug,
    intent: "build",
    identityStatus: "confirmed",
    identity: {
      symbols: { value: symbols, source },
      ...(input.assetClass ? { assetClass: { value: input.assetClass, source } } : {}),
      ...(input.interval ? { interval: { value: input.interval, source } } : {}),
      algorithmName: {
        value: input.algorithmName ?? input.workspaceSlug.split(".")[0]!,
        source,
      },
      ...(input.strategyFamily ? { strategyFamily: { value: input.strategyFamily, source } } : {}),
      ...(input.window ? { window: { value: input.window, source } } : {}),
    },
    marketDataRequired: true,
    ...flags,
  })
})

// @codescene(disable-all) Request binding is the single typed normalization boundary.
function identityFromPrompt(input: { prompt: string; messageID: string; workspaceSlug: string }): {
  identity: RequestIdentity
  status: "proposed" | "confirmed"
} {
  const proposal = parseRequestIdentityProposal(input.prompt)
  const facts = proposal.facts
  const user: FactSource = { kind: "user_message", messageId: input.messageID }
  const parser: FactSource = {
    kind: "parser_proposal",
    messageId: input.messageID,
    confidence: proposal.confidence,
    parser: proposal.parser,
  }
  const delegated: FactSource = {
    kind: "delegated_default",
    messageId: input.messageID,
    policy: "single_symbol_primary_workspace",
  }
  const symbols = facts.requested_symbols?.length
    ? facts.requested_symbols
    : facts.requested_symbol
      ? [facts.requested_symbol]
      : undefined
  const symbol = symbols?.[0]
  const window = inferBacktestWindow(input.prompt)
  const family = deriveIntent(input.prompt)
  return {
    status: proposal.status,
    identity: {
      ...(symbols ? { symbols: { value: symbols, source: proposal.status === "confirmed" ? user : parser } } : {}),
      ...(facts.requested_interval ? { interval: { value: facts.requested_interval, source: user } } : {}),
      ...(facts.requested_asset_class || symbol
        ? {
            assetClass: {
              value: facts.requested_asset_class ?? assetClassForSymbol(symbol) ?? "equity",
              source: facts.requested_asset_class ? user : delegated,
            },
          }
        : {}),
      algorithmName: {
        value: facts.requested_algorithm_name ?? input.workspaceSlug.split(".")[0]!,
        source: facts.requested_algorithm_name ? user : delegated,
      },
      ...(family ? { strategyFamily: { value: family, source: user } } : {}),
      ...(window.start && window.end
        ? { window: { value: { start: window.start, end: window.end }, source: user } }
        : {}),
    },
  }
}

function persistedParentUserText(input: { sessionID: string; messageID: string }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const message = yield* db
      .select()
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.id, input.messageID as (typeof MessageTable.$inferSelect)["id"]),
          eq(MessageTable.session_id, input.sessionID as (typeof MessageTable.$inferSelect)["session_id"]),
        ),
      )
      .get()
    if (!message || message.data.role !== "user") return undefined
    const parts = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, input.messageID as (typeof PartTable.$inferSelect)["message_id"]))
      .all()
    const text = parts
      .map((part) => part.data as { type?: string; text?: string; synthetic?: boolean })
      .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n")
      .trim()
    return text || undefined
  })
}

/**
 * Create exactly one authoritative workflow for a top-level Finny/Build
 * session. Later prompts and all child sessions only rematerialize its derived
 * request.json; they cannot promote their own prompt text into request facts.
 */
// @codescene(disable-all) Primary workflow binding enforces the user-message trust boundary.
export function ensurePrimaryBuildWorkflow(input: {
  sessionID: string
  messageID: string
  agent: string
  parentSessionID?: string
}) {
  return Effect.gen(function* () {
    if (!PRIMARY_BUILD_AGENTS.has(input.agent) || input.parentSessionID) return undefined
    const prompt = yield* persistedParentUserText({ sessionID: input.sessionID, messageID: input.messageID })
    if (!prompt) return undefined

    let existing = (yield* BuildWorkflowStore.listBySession(input.sessionID)).find(
      (state) => state.status === "active" || state.status === "blocked",
    )
    if (existing) {
      const pending = existing.approvalChallenges.filter((challenge) => challenge.status === "pending")
      const decision = unambiguousApprovalDecision(prompt)
      if (pending.length === 1 && decision) {
        const challenge = pending[0]!
        const occurredAt = Date.now()
        const event: WorkflowEvent =
          decision === "approve"
            ? {
                id: `evt_approval_message_${crypto.randomUUID()}`,
                type: "approval.granted",
                occurredAt,
                source: { actor: "user", messageId: input.messageID },
                challengeId: challenge.id,
                scopeHash: challenge.scopeHash,
              }
            : {
                id: `evt_approval_message_${crypto.randomUUID()}`,
                type: "approval.rejected",
                occurredAt,
                source: { actor: "user", messageId: input.messageID },
                challengeId: challenge.id,
              }
        const result = yield* BuildWorkflowStore.append({
          workflowId: existing.workflowId,
          expectedRevision: existing.revision,
          event,
        })
        if (result.kind === "applied") existing = result.decision.state
      }
      const current = existing
      yield* Effect.tryPromise(() => writeWorkflowRequestProjection(current))
      return current
    }

    // Do not create a generic strategy workspace from a vague request. The
    // first concrete identity must come from a later user clarification, not
    // from model-authored workspace tool arguments in the same turn.
    if (requiresIdentityClarification(prompt)) return undefined

    const workspace = yield* Effect.tryPromise(() => bootstrapWorkspace(input.sessionID, prompt))
    if (!workspace) return undefined
    const flags = workflowClaimFlags(prompt)
    const parsed = identityFromPrompt({ prompt, messageID: input.messageID, workspaceSlug: workspace.slug })
    const state = yield* BuildWorkflowStore.insert({
      workflowId: workflowID(input.sessionID, input.messageID),
      sessionId: input.sessionID,
      workspaceSlug: workspace.slug,
      intent: "build",
      identity: parsed.identity,
      identityStatus: parsed.status,
      marketDataRequired: true,
      ...flags,
    })
    yield* Effect.tryPromise(() => writeWorkflowRequestProjection(state))
    return state
  })
}

export type EnsurePrimaryBuildWorkflowResult = BuildWorkflowState | undefined
