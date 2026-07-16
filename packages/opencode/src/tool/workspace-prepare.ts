import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { algoDir } from "@finny-ai/core/algo"
import { bootstrapWorkspace } from "../plugin/finny-workspace"
import { syncWorkspaceRequestContext, writeWorkflowRequestProjection } from "../agent/finny-workspace-context"
import {
  ResearchBriefContentSchema,
  inspectResearchBrief,
  researchBriefIdentity,
  updateResearchBrief,
} from "../agent/research-brief"
import { readRequestSpec, requestSpecProjection } from "../agent/request-spec"
import { normalizeInterval, normalizeSymbol, parseRequestFacts, type RequestFacts } from "../agent/request-identity"
import { BuildWorkflowStore } from "../algorithm/build-workflow/store"
import { transitionWorkflowIdentity } from "../algorithm/build-workflow/lifecycle"
import { Tool } from "./tool"

const parameters = z.object({
  requestSummary: z
    .string()
    .optional()
    .describe(
      "Concise strategy request summary. Use when the user's request is not directly available in the current turn.",
    ),
  algorithmName: z.string().optional().describe("Optional intended algorithm/workspace name, kebab-case when known."),
  symbol: z.string().optional().describe("Primary requested symbol, e.g. BTC.USD, BTC/USD, SPY."),
  symbols: z.array(z.string()).optional().describe("Requested symbol universe for multi-symbol work."),
  assetClass: z.enum(["equity", "crypto"]).optional().describe("Requested asset class."),
  interval: z.string().optional().describe("Requested bar interval, e.g. 4h, 1h, 1d."),
  duration: z.string().optional().describe("Requested backtest/data window, e.g. 1y, 6m, one year."),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  strategyIntent: z
    .string()
    .optional()
    .describe("Requested or delegated strategy intent/family, e.g. momentum or delegated."),
  researchBrief: ResearchBriefContentSchema.optional().describe(
    "Typed Research-to-Build handoff content. Edits always reset an existing approval to draft.",
  ),
  transition: z
    .enum(["draft", "approved", "cancelled"])
    .optional()
    .describe(
      "ResearchBrief transition. Models may set draft/cancelled freely. transition=approved requires an explicit user permission grant in this tool call and a complete brief.",
    ),
})

type WorkspacePrepareParams = z.infer<typeof parameters>

type WorkspacePrepareWindow = {
  startDate?: string
  endDate?: string
  error?: string
}

const DURATION_UNITS: Record<string, "d" | "w" | "m" | "y"> = {
  d: "d",
  day: "d",
  days: "d",
  w: "w",
  week: "w",
  weeks: "w",
  m: "m",
  month: "m",
  months: "m",
  y: "y",
  year: "y",
  years: "y",
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function subtractCalendarMonths(value: Date, months: number): Date {
  const day = value.getUTCDate()
  const shifted = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() - months, 1))
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  shifted.setUTCDate(Math.min(day, lastDay))
  return shifted
}

function parseDuration(duration: string): { count: number; unit: "d" | "w" | "m" | "y" } | undefined {
  const match = /^(\d+|one)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/i.exec(duration.trim())
  if (!match) return undefined
  const count = match[1].toLowerCase() === "one" ? 1 : Number.parseInt(match[1], 10)
  const unit = DURATION_UNITS[match[2].toLowerCase()]
  if (!Number.isFinite(count) || count <= 0 || !unit) return undefined
  return { count, unit }
}

export function resolveWorkspacePrepareWindow(
  params: Pick<WorkspacePrepareParams, "duration" | "startDate" | "endDate">,
  now = new Date(),
): WorkspacePrepareWindow {
  if (params.startDate || params.endDate) {
    if (!params.startDate || !params.endDate) {
      return {
        error:
          "Incomplete date window: provide both startDate and endDate, or omit both and provide a supported duration.",
      }
    }
    return { startDate: params.startDate, endDate: params.endDate }
  }
  if (!params.duration) return {}
  const parsed = parseDuration(params.duration)
  if (!parsed) return {}

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end)
  if (parsed.unit === "d") start.setUTCDate(start.getUTCDate() - parsed.count)
  if (parsed.unit === "w") start.setUTCDate(start.getUTCDate() - parsed.count * 7)
  if (parsed.unit === "m") {
    return { startDate: formatUtcDate(subtractCalendarMonths(end, parsed.count)), endDate: formatUtcDate(end) }
  }
  if (parsed.unit === "y") {
    return { startDate: formatUtcDate(subtractCalendarMonths(end, parsed.count * 12)), endDate: formatUtcDate(end) }
  }
  return { startDate: formatUtcDate(start), endDate: formatUtcDate(end) }
}

type WorkspacePrepareMetadata = {
  workspaceSlug?: string
  workspacePath?: string
  created?: boolean
  rebound?: boolean
  requestContext?: Record<string, unknown>
  researchBrief?: Record<string, unknown>
  buildReady?: boolean
}

function latestUserText(messages: Tool.Context["messages"]): string {
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "user") continue
    const parts = Array.isArray((message as any).parts) ? (message as any).parts : []
    const text = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string" && !part.synthetic)
      .map((part: any) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

export function promptFromParams(params: WorkspacePrepareParams, fallback: string): string {
  const fields: Array<[string, string | undefined]> = [
    ["algorithm", params.algorithmName],
    ["symbol", params.symbol],
    ["symbols", params.symbols?.join(", ")],
    ["asset class", params.assetClass],
    ["interval", params.interval],
    ["backtest window", params.duration],
    ["date window", params.startDate && params.endDate ? `${params.startDate} to ${params.endDate}` : undefined],
    ["strategy intent", params.strategyIntent],
  ]
  const lines = fields.flatMap(([label, value]) => (value ? [`${label} ${value}`] : []))
  if (params.requestSummary?.trim()) {
    // Structured tool inputs are the validated request identity. Put every
    // supplied field before the lossy prose summary so parsers can never let a
    // strategy detail (for example SMA(200)) replace an explicit 1d interval.
    const summary = params.requestSummary.trim()
    return lines.length ? `${lines.join("; ")}; request summary ${summary}` : summary
  }
  if (lines.length) return lines.join("; ")
  return fallback
}

function structuredRequestFacts(params: WorkspacePrepareParams): RequestFacts {
  return {
    requested_symbol: params.symbol,
    requested_symbols: params.symbols,
    requested_asset_class: params.assetClass,
    requested_interval: params.interval,
    requested_algorithm_name: params.algorithmName,
  }
}

export function workspacePrepareIdentityConflict(
  params: Pick<WorkspacePrepareParams, "symbol" | "symbols" | "assetClass" | "interval">,
  userPrompt: string,
): string | undefined {
  const user = parseRequestFacts(userPrompt)
  const requested = structuredRequestFacts(params as WorkspacePrepareParams)
  const userSymbol = normalizeSymbol(user.requested_symbol)
  const toolSymbol = normalizeSymbol(requested.requested_symbol)
  const userSymbols = user.requested_symbols?.map(normalizeSymbol).filter((value): value is string => Boolean(value))
  const toolSymbols = requested.requested_symbols
    ?.map(normalizeSymbol)
    .filter((value): value is string => Boolean(value))
  const userInterval = normalizeInterval(user.requested_interval)
  const toolInterval = normalizeInterval(requested.requested_interval)

  const conflicts: string[] = []
  if (userSymbol && toolSymbol && userSymbol !== toolSymbol) {
    conflicts.push(`symbol ${toolSymbol} conflicts with the user's ${userSymbol}`)
  }
  if (userSymbols?.length && toolSymbols?.length) {
    const left = [...new Set(userSymbols)].sort().join(",")
    const right = [...new Set(toolSymbols)].sort().join(",")
    if (left !== right) conflicts.push(`symbols ${right} conflict with the user's ${left}`)
  }
  if (userInterval && toolInterval && userInterval !== toolInterval) {
    conflicts.push(`interval ${toolInterval} conflicts with the user's ${userInterval}`)
  }
  if (
    user.requested_asset_class &&
    requested.requested_asset_class &&
    user.requested_asset_class !== requested.requested_asset_class
  ) {
    conflicts.push(
      `asset class ${requested.requested_asset_class} conflicts with the user's ${user.requested_asset_class}`,
    )
  }
  if (conflicts.length === 0) return undefined

  return [
    `Request identity rejected: ${conflicts.join("; ")}.`,
    "Preserve the exact symbol, interval, and asset class from the latest user request.",
    "Do not substitute a proxy ticker. Call finny_workspace_prepare again with the user's identity, or ask the user for explicit permission to change it.",
  ].join(" ")
}

async function readRequestContext(requestID: string): Promise<Record<string, unknown> | undefined> {
  const spec = await readRequestSpec({ requestID })
  return spec ? requestSpecProjection(spec) : undefined
}

export const WorkspacePrepareTool = Tool.define<
  typeof parameters,
  WorkspacePrepareMetadata,
  Database.Service,
  "finny_workspace_prepare"
>(
  "finny_workspace_prepare",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
    description:
      "Create or bind the session strategy workspace from request identity before evidence subagents, save, validate, or backtest. Returns the workspace slug, path, and request context; do not manually invent repo-root workspace paths.",
    parameters,
    execute: (params: WorkspacePrepareParams, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const window = resolveWorkspacePrepareWindow(params)
        if (window.error) {
          return { title: "Workspace prepare failed", output: window.error, metadata: {} }
        }
        const effectiveParams: WorkspacePrepareParams = { ...params, ...window }
        const userText = latestUserText(ctx.messages)
        const identityConflict = workspacePrepareIdentityConflict(effectiveParams, userText)
        if (identityConflict) {
          return {
            title: "Workspace prepare rejected",
            output: identityConflict,
            metadata: {},
          }
        }

        await ctx.ask({
          permission: "finny_workspace_prepare",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const prompt = promptFromParams(effectiveParams, userText)
        if (!prompt.trim()) {
          return {
            title: "Workspace prepare failed",
            output: "No request text or structured request identity was provided.",
            metadata: {},
          }
        }

        const workflows = await Effect.runPromise(
          BuildWorkflowStore.listBySession(ctx.sessionID).pipe(Effect.provideService(Database.Service, database)),
        )
        const workflow = workflows.find((item) => item.status === "active" || item.status === "blocked")
        let workflowProjection: Record<string, unknown> | undefined
        const hasStructuredIdentity = Boolean(
          effectiveParams.symbol ||
          effectiveParams.symbols?.length ||
          effectiveParams.assetClass ||
          effectiveParams.interval ||
          effectiveParams.algorithmName ||
          effectiveParams.strategyIntent ||
          (effectiveParams.startDate && effectiveParams.endDate),
        )
        if (workflow && hasStructuredIdentity) {
          const source = {
            kind: "structured_tool" as const,
            tool: "finny_workspace_prepare",
            callId: String(ctx.callID),
          }
          const symbols = effectiveParams.symbols?.length
            ? effectiveParams.symbols
            : effectiveParams.symbol
              ? [effectiveParams.symbol]
              : undefined
          const transitioned = await Effect.runPromise(
            transitionWorkflowIdentity({
              sessionId: ctx.sessionID,
              source: { actor: "tool" },
              reason: "structured workspace identity confirmation",
              identity: {
                ...workflow.identity,
                ...(symbols ? { symbols: { value: symbols, source } } : {}),
                ...(effectiveParams.assetClass ? { assetClass: { value: effectiveParams.assetClass, source } } : {}),
                ...(effectiveParams.interval ? { interval: { value: effectiveParams.interval, source } } : {}),
                ...(effectiveParams.algorithmName
                  ? { algorithmName: { value: effectiveParams.algorithmName, source } }
                  : {}),
                ...(effectiveParams.strategyIntent
                  ? { strategyFamily: { value: effectiveParams.strategyIntent, source } }
                  : {}),
                ...(effectiveParams.startDate && effectiveParams.endDate
                  ? { window: { value: { start: effectiveParams.startDate, end: effectiveParams.endDate }, source } }
                  : {}),
              },
            }).pipe(Effect.provideService(Database.Service, database)),
          )
          if (transitioned) workflowProjection = { ...(await writeWorkflowRequestProjection(transitioned)) }
        }

        const prepared = await bootstrapWorkspace(ctx.sessionID, prompt, structuredRequestFacts(effectiveParams))
        if (!prepared) {
          return {
            title: "Workspace prepare skipped",
            output: "No strategy workspace was needed for this request.",
            metadata: {},
          }
        }

        const workspacePath = prepared.dir || algoDir(prepared.slug)
        // WorkflowRun owns request identity when present. Legacy sessions still
        // persist the explicit, permissioned tool inputs through RequestSpec.
        const requestContext: Record<string, unknown> | undefined = workflow
          ? workflowProjection ?? (await readRequestContext(ctx.sessionID))
          : {
              ...(await syncWorkspaceRequestContext({
                sessionID: ctx.sessionID,
                slug: prepared.slug,
                prompt,
                facts: structuredRequestFacts(effectiveParams),
                recordExplicitRequestContext: true,
                actor: "user",
                reason: "finny_workspace_prepare explicit request context",
              })),
            }
        // Models cannot self-approve Research→Build handoffs. Approval is a user decision.
        if (params.transition === "approved") {
          await ctx.ask({
            permission: "research_brief_approve",
            patterns: ["*"],
            always: ["*"],
            metadata: {
              workspaceSlug: prepared.slug,
              workspacePath,
              requestContext,
            },
          })
        }
        const researchStatus =
          params.researchBrief || params.transition
            ? await updateResearchBrief({
                workspacePath,
                identity: researchBriefIdentity(requestContext ?? {}),
                content: params.researchBrief,
                transition: params.transition,
              })
            : await inspectResearchBrief(workspacePath)
        const output = [
          `workspace_slug: ${prepared.slug}`,
          `workspace_path: ${workspacePath}`,
          `created: ${prepared.created}`,
          `rebound: ${prepared.rebound}`,
          `mission_path: ${path.join(workspacePath, "mission.md")}`,
          `todo_path: ${path.join(workspacePath, "todo.md")}`,
          `edge_analysis_path: ${path.join(workspacePath, "edge_analysis.md")}`,
          `data_dir: ${path.join(workspacePath, "data")}`,
          requestContext ? `request_context: ${JSON.stringify(requestContext)}` : undefined,
          researchStatus.exists ? `research_brief: ${path.join(workspacePath, "research-brief.json")}` : undefined,
          researchStatus.exists ? `research_transition: ${researchStatus.brief?.transition}` : undefined,
          researchStatus.exists ? `research_revision: ${researchStatus.brief?.revision}` : undefined,
          researchStatus.exists ? `build_ready: ${researchStatus.buildReady}` : undefined,
          researchStatus.reason ? `handoff_blocker: ${researchStatus.reason}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")

        return {
          title: prepared.created ? `Created workspace ${prepared.slug}` : `Using workspace ${prepared.slug}`,
          output,
          metadata: {
            workspaceSlug: prepared.slug,
            workspacePath,
            created: prepared.created,
            rebound: prepared.rebound,
            requestContext,
            researchBrief: researchStatus.brief as unknown as Record<string, unknown> | undefined,
            buildReady: researchStatus.buildReady,
          },
        }
      }),
    }
  }),
)
