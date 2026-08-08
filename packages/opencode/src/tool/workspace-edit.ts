import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { writeWorkflowRequestProjection } from "../agent/finny-workspace-context"
import {
  commitRequestSpec,
  readRequestSpec,
  readRequestSpecHistory,
  requestSpecProjection,
  writeRequestSpecProjection,
} from "../agent/request-spec"
import { normalizeInterval } from "../agent/request-identity"
import { BuildWorkflowStore } from "../algorithm/build-workflow/store"
import { transitionWorkflowIdentity } from "../algorithm/build-workflow/lifecycle"
import { providerLookbackFloor, type DataProviderID } from "../data/data-provider-capabilities"
import { clampEndDateToCompletedCoverage } from "./workspace-prepare"
import { Tool } from "./tool"

/**
 * `finny_workspace_edit` is the amend-in-place counterpart to
 * `finny_workspace_prepare`. When `data_extractor` returns BLOCKED, the only
 * lever the model used to have was calling prepare again — which either hit the
 * confirmed-identity lock (a dead end) or re-derived a slug and provisioned a
 * *new* workspace, orphaning the data, mission, and manifests of the one the
 * session was actually working in. This tool edits the bound workspace's
 * request window in place and never creates, renames, or rebinds a slug.
 *
 * Instrument identity (symbol, universe, asset class, algorithm name) is out of
 * scope by construction: changing it means a different strategy, which is a
 * legitimate `finny_workspace_prepare` call, not an edit.
 */

/** Reason prefix that marks an amendment as produced by this tool, so retries can be counted. */
export const WORKSPACE_EDIT_REASON_PREFIX = "finny_workspace_edit:"

/** Mirrors CLAUDE.md's "stop after two backtest failures": a dead provider must not loop forever. */
export const WORKSPACE_EDIT_MAX_ATTEMPTS = 2

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const PROVIDER_IDS = [
  "alpaca",
  "polygon",
  "yfinance",
  "binance",
  "zerodha",
  "saxo",
  "questrade",
  "futu",
] as const satisfies readonly DataProviderID[]

const parameters = z.object({
  blocker: z
    .string()
    .describe(
      "The verbatim BLOCKED line or coverage note returned by data_extractor. Required provenance; do not paraphrase or invent it.",
    ),
  reason: z.string().describe("Why this edit unblocks the extraction, in one sentence."),
  startDate: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe("Amended requested_start. Omit to keep the current start."),
  endDate: z.string().regex(DATE_RE).optional().describe("Amended requested_end. Omit to keep the current end."),
  interval: z
    .string()
    .optional()
    .describe("Amended bar interval. Always requires user approval; never a mechanical repair."),
  provider: z
    .enum(PROVIDER_IDS)
    .optional()
    .describe(
      "Provider the next data_extractor run should prefer. Required to justify a start-date clamp against that provider's documented lookback limit.",
    ),
  userApproved: z
    .boolean()
    .optional()
    .describe(
      "Set only after the user answered a `question` tool round-trip approving this exact change. Never set it to describe your own reasoning.",
    ),
})

type WorkspaceEditParams = z.infer<typeof parameters>

export interface WorkspaceEditIdentity {
  start?: string
  end?: string
  interval?: string
  assetClass?: string
  symbols: string[]
  algorithmName?: string
}

export type WorkspaceEditClassification =
  | { kind: "no_change" }
  | { kind: "mechanical"; edits: string[] }
  | { kind: "needs_user_approval"; edits: string[]; blockers: string[] }
  | { kind: "rejected"; message: string }

function isMechanicalEndClamp(input: {
  requestedEnd: string
  currentEnd: string
  assetClass?: string
  interval?: string
  now?: Date
}) {
  // Only one end-date edit is mechanical: pulling an end that still contains an
  // open candle back to the last completed one. Any other end change — in
  // particular one that shortens history to whatever a provider happened to
  // return — is a scope decision the user owns.
  if (input.requestedEnd >= input.currentEnd) return false
  return (
    input.requestedEnd ===
    clampEndDateToCompletedCoverage({
      endDate: input.currentEnd,
      assetClass: input.assetClass,
      interval: input.interval,
      now: input.now,
    })
  )
}

function isMechanicalStartClamp(input: {
  requestedStart: string
  currentStart: string
  provider?: DataProviderID
  interval?: string
  now?: Date
}) {
  // A start clamp is mechanical only when the runtime can independently verify
  // the floor from the provider capability table. An agent-asserted "the
  // provider only had 6 months" is not proof and falls through to approval.
  if (!input.provider) return false
  if (input.requestedStart <= input.currentStart) return false
  const floor = providerLookbackFloor({ provider: input.provider, interval: input.interval, now: input.now })
  if (!floor) return false
  return input.currentStart < floor && input.requestedStart === floor
}

/**
 * Decide whether an edit is a provable repair the runtime can apply on its own,
 * or a narrowing of what the user asked for that needs their explicit sign-off.
 */
export function classifyWorkspaceEdit(input: {
  current: WorkspaceEditIdentity
  requested: Pick<WorkspaceEditParams, "startDate" | "endDate" | "interval">
  provider?: DataProviderID
  now?: Date
}): WorkspaceEditClassification {
  const current = input.current
  const requestedInterval = normalizeInterval(input.requested.interval ?? "") ?? undefined
  const nextStart = input.requested.startDate ?? current.start
  const nextEnd = input.requested.endDate ?? current.end
  const nextInterval = requestedInterval ?? current.interval

  if (!current.start || !current.end) {
    return {
      kind: "rejected",
      message:
        "The bound workspace has no requested_start/requested_end to amend. Call finny_workspace_prepare with the approved window first.",
    }
  }
  if (nextStart && nextEnd && nextStart > nextEnd) {
    return { kind: "rejected", message: `Amended window is empty (${nextStart} to ${nextEnd}).` }
  }

  const edits: string[] = []
  const blockers: string[] = []

  if (input.requested.endDate && input.requested.endDate !== current.end) {
    edits.push(`requested_end ${current.end} → ${input.requested.endDate}`)
    if (
      !isMechanicalEndClamp({
        requestedEnd: input.requested.endDate,
        currentEnd: current.end,
        assetClass: current.assetClass,
        interval: nextInterval,
        now: input.now,
      })
    ) {
      blockers.push(
        `requested_end ${input.requested.endDate} is not the last completed candle for ${current.end}; it changes the window the user approved`,
      )
    }
  }

  if (input.requested.startDate && input.requested.startDate !== current.start) {
    edits.push(`requested_start ${current.start} → ${input.requested.startDate}`)
    if (
      !isMechanicalStartClamp({
        requestedStart: input.requested.startDate,
        currentStart: current.start,
        provider: input.provider,
        interval: nextInterval,
        now: input.now,
      })
    ) {
      blockers.push(
        `requested_start ${input.requested.startDate} is not a documented lookback floor for ${input.provider ?? "the unspecified provider"}; shortening history is the user's decision`,
      )
    }
  }

  if (requestedInterval && requestedInterval !== current.interval) {
    edits.push(`requested_interval ${current.interval ?? "MISSING"} → ${requestedInterval}`)
    blockers.push(`interval changes are never mechanical; ${requestedInterval} must be approved by the user`)
  }

  if (edits.length === 0) return { kind: "no_change" }
  if (blockers.length > 0) return { kind: "needs_user_approval", edits, blockers }
  return { kind: "mechanical", edits }
}

export function workspaceEditApprovalPrompt(input: { edits: string[]; blockers: string[]; blocker: string }) {
  return [
    "Workspace edit needs user approval before it can be applied.",
    `Data Agent blocker: ${input.blocker}`,
    `Proposed change: ${input.edits.join("; ")}.`,
    `Not a mechanical repair because: ${input.blockers.join("; ")}.`,
    "Ask the user with the `question` tool, stating the blocker, the exact proposed window, and what is lost by narrowing it.",
    "Only after they approve, call finny_workspace_edit again with the same values plus userApproved: true.",
    "Keeping the confirmed window and running research-only is a valid alternative — offer it.",
  ].join(" ")
}

export function workspaceEditAttemptCap(attempts: number, blocker: string) {
  if (attempts < WORKSPACE_EDIT_MAX_ATTEMPTS) return undefined
  return [
    `Workspace edit refused: ${attempts} amendment attempts already ran for this request.`,
    `Latest Data Agent blocker: ${blocker}`,
    "Stop editing the window and report the blocker to the user with the sources already attempted and the smallest next action.",
    "Do not create a new workspace to work around this.",
  ].join(" ")
}

function contextBlock(input: {
  slug: string
  workspacePath: string
  context: Record<string, unknown>
  provider?: DataProviderID
}) {
  const value = (key: string) => {
    const item = input.context[key]
    if (typeof item === "string") return item.trim() || "MISSING"
    if (typeof item === "number" || typeof item === "boolean") return String(item)
    return "MISSING"
  }
  const symbols = Array.isArray(input.context.requested_symbols)
    ? (input.context.requested_symbols as unknown[]).join(", ")
    : undefined
  return [
    "Data request context (amended; pass this verbatim to data_extractor):",
    `- workspace_slug: ${input.slug}`,
    `- allowed_data_dir: ${path.join(input.workspacePath, "data")}`,
    `- request_id: ${value("request_id")}`,
    `- request_version: ${value("request_version")}`,
    `- request_content_hash: ${value("request_content_hash")}`,
    `- requested_algorithm_name: ${value("requested_algorithm_name")}`,
    `- requested_symbol: ${value("requested_symbol")}`,
    `- requested_symbols: ${symbols ?? "MISSING"}`,
    `- requested_asset_class: ${value("requested_asset_class")}`,
    `- requested_interval: ${value("requested_interval")}`,
    `- requested_start: ${value("requested_start")}`,
    `- requested_end: ${value("requested_end")}`,
    ...(input.provider ? [`- preferred_provider: ${input.provider}`] : []),
  ]
}

type WorkspaceEditMetadata = {
  workspaceSlug?: string
  workspacePath?: string
  applied?: boolean
  classification?: WorkspaceEditClassification["kind"]
  edits?: string[]
  attempts?: number
  requestContext?: Record<string, unknown>
}

export const WorkspaceEditTool = Tool.define<
  typeof parameters,
  WorkspaceEditMetadata,
  Database.Service,
  "finny_workspace_edit"
>(
  "finny_workspace_edit",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Amend the data window of the workspace already bound to this session after data_extractor returns BLOCKED, then relaunch data_extractor with the returned context. Edits in place — it never creates, renames, or rebinds a workspace, and it cannot change symbol, universe, asset class, or algorithm name. Clamping an open end candle or a documented provider lookback floor applies immediately; anything that narrows the user's approved window or changes interval is refused until the user approves it through the question tool.",
      parameters,
      execute: (params: WorkspaceEditParams, ctx: Tool.Context) =>
        Effect.promise(async () => {
          const slug = await getSessionWorkspace(ctx.sessionID)
          if (!slug) {
            return {
              title: "Workspace edit failed",
              output:
                "No workspace is bound to this session. Call finny_workspace_prepare first; finny_workspace_edit only amends an existing binding.",
              metadata: {},
            }
          }
          const workspacePath = algoDir(slug)

          const workflows = await Effect.runPromise(
            BuildWorkflowStore.listBySession(ctx.sessionID).pipe(Effect.provideService(Database.Service, database)),
          )
          const workflow = workflows.find((item) => item.status === "active" || item.status === "blocked")
          const spec = await readRequestSpec({ requestID: ctx.sessionID })

          const current: WorkspaceEditIdentity = workflow
            ? {
                start: workflow.identity.window?.value.start,
                end: workflow.identity.window?.value.end,
                interval: normalizeInterval(workflow.identity.interval?.value ?? "") ?? undefined,
                assetClass: workflow.identity.assetClass?.value,
                symbols: workflow.identity.symbols?.value ?? [],
                algorithmName: workflow.identity.algorithmName?.value,
              }
            : {
                start: spec?.requested_start,
                end: spec?.requested_end,
                interval: spec?.requested_interval,
                assetClass: spec?.requested_asset_class,
                symbols: spec?.requested_symbols ?? (spec?.requested_symbol ? [spec.requested_symbol] : []),
                algorithmName: spec?.requested_algorithm_name,
              }

          const attempts = workflow
            ? workflow.invalidations.filter((item) => item.reason.startsWith(WORKSPACE_EDIT_REASON_PREFIX)).length
            : (await readRequestSpecHistory({ requestID: ctx.sessionID })).filter((item) =>
                item.reason.startsWith(WORKSPACE_EDIT_REASON_PREFIX),
              ).length
          const capped = workspaceEditAttemptCap(attempts, params.blocker)
          if (capped) {
            return {
              title: "Workspace edit refused",
              output: capped,
              metadata: { workspaceSlug: slug, workspacePath, applied: false, attempts },
            }
          }

          const classification = classifyWorkspaceEdit({
            current,
            requested: params,
            provider: params.provider,
          })
          if (classification.kind === "rejected") {
            return {
              title: "Workspace edit rejected",
              output: classification.message,
              metadata: { workspaceSlug: slug, workspacePath, applied: false, classification: classification.kind },
            }
          }
          if (classification.kind === "needs_user_approval" && !params.userApproved) {
            return {
              title: "Workspace edit needs approval",
              output: workspaceEditApprovalPrompt({
                edits: classification.edits,
                blockers: classification.blockers,
                blocker: params.blocker,
              }),
              metadata: {
                workspaceSlug: slug,
                workspacePath,
                applied: false,
                classification: classification.kind,
                edits: classification.edits,
                attempts,
              },
            }
          }
          if (classification.kind === "needs_user_approval") {
            // `ctx.ask` returns an Effect, so it has to be run — a bare `await`
            // on it resolves immediately and silently skips the permission gate.
            await Effect.runPromise(
              ctx.ask({
                permission: "finny_workspace_edit_identity",
                patterns: ["*"],
                always: [],
                metadata: {
                  workspaceSlug: slug,
                  workspacePath,
                  edits: classification.edits,
                  blockers: classification.blockers,
                  blocker: params.blocker,
                },
              }),
            )
          }

          const nextStart = params.startDate ?? current.start
          const nextEnd = params.endDate ?? current.end
          const nextInterval = normalizeInterval(params.interval ?? "") ?? current.interval
          const reason = `${WORKSPACE_EDIT_REASON_PREFIX} ${params.reason} (blocker: ${params.blocker})`

          let requestContext: Record<string, unknown> = {}
          if (classification.kind === "no_change") {
            requestContext = workflow
              ? { ...(await writeWorkflowRequestProjection(workflow)) }
              : spec
                ? requestSpecProjection(spec)
                : {}
          } else if (workflow) {
            const source = {
              kind: "structured_tool" as const,
              tool: "finny_workspace_edit",
              callId: String(ctx.callID),
            }
            const amended = await Effect.runPromise(
              transitionWorkflowIdentity({
                sessionId: ctx.sessionID,
                source: { actor: params.userApproved ? "user" : "tool" },
                reason,
                identity: {
                  ...workflow.identity,
                  ...(nextInterval ? { interval: { value: nextInterval, source } } : {}),
                  ...(nextStart && nextEnd ? { window: { value: { start: nextStart, end: nextEnd }, source } } : {}),
                },
              }).pipe(Effect.provideService(Database.Service, database)),
            )
            if (!amended) {
              return {
                title: "Workspace edit failed",
                output: "The bound Build workflow could not be amended. Report the Data Agent blocker to the user.",
                metadata: { workspaceSlug: slug, workspacePath, applied: false },
              }
            }
            requestContext = { ...(await writeWorkflowRequestProjection(amended)) }
          } else {
            const committed = await commitRequestSpec({
              requestID: ctx.sessionID,
              identity: {
                requested_symbol: current.symbols.length === 1 ? current.symbols[0] : spec?.requested_symbol,
                requested_symbols: current.symbols.length > 1 ? current.symbols : spec?.requested_symbols,
                requested_asset_class: spec?.requested_asset_class,
                requested_interval: nextInterval,
                requested_start: nextStart,
                requested_end: nextEnd,
                requested_algorithm_name: current.algorithmName,
              },
              actor: params.userApproved ? "user" : "runtime",
              reason,
              approvalState: params.userApproved ? "approved" : "pending",
            })
            await writeRequestSpecProjection({ workspaceDir: workspacePath, spec: committed })
            requestContext = requestSpecProjection(committed)
          }

          const applied = classification.kind !== "no_change"
          const output = [
            applied
              ? `Amended workspace ${slug} in place: ${classification.edits.join("; ")}.`
              : `No identity change was needed for workspace ${slug}.`,
            `Data Agent blocker: ${params.blocker}`,
            `Amendment ${attempts + (applied ? 1 : 0)} of ${WORKSPACE_EDIT_MAX_ATTEMPTS}.`,
            "",
            ...contextBlock({ slug, workspacePath, context: requestContext, provider: params.provider }),
            "",
            "Relaunch data_extractor now with this context block. Do not call finny_workspace_prepare and do not start a new workspace.",
          ].join("\n")

          return {
            title: applied ? `Edited workspace ${slug}` : `Workspace ${slug} unchanged`,
            output,
            metadata: {
              workspaceSlug: slug,
              workspacePath,
              applied,
              classification: classification.kind,
              edits: classification.kind === "no_change" ? [] : classification.edits,
              attempts: attempts + (applied ? 1 : 0),
              requestContext,
            },
          }
        }),
    }
  }),
)
