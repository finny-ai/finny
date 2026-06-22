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
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { algoDir, bindSessionWorkspace, getSessionWorkspace, humanNameOf } from "@finny-ai/core/algo"
import * as path from "path"
import { assetClassForSymbol, parseRequestFacts } from "@/agent/request-identity"
import {
  algorithmNameFromWorkspaceSlug,
  extractDateWindow,
  inferBacktestWindow,
  syncWorkspaceRequestContext,
  type WorkspaceRequestContext,
} from "@/agent/finny-workspace-context"
import { bootstrapWorkspace } from "@/plugin/finny-workspace"
import {
  validateDataExtractorTaskText,
  validateExistingDataExtractorEvidence,
} from "@/data/data-extractor-evidence"
import { parseSecRequestContext } from "@/data/sec-edgar"

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
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
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

function isoUtcDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function previousUtcDate(date: Date) {
  const prev = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  prev.setUTCDate(prev.getUTCDate() - 1)
  return isoUtcDate(prev)
}

export function completedIntradayWindow(input: {
  start?: string
  end?: string
  interval?: string
  now?: Date
}) {
  const now = input.now ?? new Date()
  const today = isoUtcDate(now)
  if (!input.end || input.end !== today || !isIntradayInterval(input.interval)) {
    return { start: input.start, end: input.end, adjusted: false }
  }
  return { start: input.start, end: previousUtcDate(now), adjusted: true }
}

function dataExtractorValidationContext(context: WorkspaceRequestContext | undefined): WorkspaceRequestContext | undefined {
  if (!context) return undefined
  const window = completedIntradayWindow({
    start: context.requested_start,
    end: context.requested_end,
    interval: context.requested_interval,
  })
  if (!window.adjusted) return context
  return {
    ...context,
    requested_start: window.start,
    requested_end: window.end,
  }
}

function withFinnySubagentContext(
  params: { subagent_type: string },
  prompt: string,
  workspace: string | null,
  context?: WorkspaceRequestContext,
) {
  if (!workspace) return prompt
  if (
    params.subagent_type !== "data_extractor" &&
    params.subagent_type !== "news_agent" &&
    params.subagent_type !== "researcher" &&
    params.subagent_type !== "sec_agent"
  )
    return prompt

  const workspacePath = algoDir(workspace)
  const dataDir = path.join(workspacePath, "data")
  const newsDir = path.join(dataDir, "news")
  const facts = parseRequestFacts(prompt)
  const window = extractDateWindow(prompt)
  const inferred = inferBacktestWindow(prompt)
  const symbol = context?.requested_symbol ?? facts.requested_symbol
  const interval = context?.requested_interval ?? facts.requested_interval
  const assetClass = context?.requested_asset_class ?? facts.requested_asset_class ?? assetClassForSymbol(symbol)
  const algorithmName =
    context?.requested_algorithm_name ??
    facts.requested_algorithm_name ??
    algorithmNameFromWorkspaceSlug(workspace)
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
      field("symbols or universe", symbol),
      field("interval", interval),
      field("start date as absolute YYYY-MM-DD", dataWindow.start),
      field("end date as absolute YYYY-MM-DD", dataWindow.end),
      field("asset_class when known", assetClass),
      field("mission_path when known", path.join(workspacePath, "mission.md")),
      field("allowed_data_dir when known", dataDir),
      "- cookbook_path: data-agent/instructions.md",
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
      field("requested_company_or_ticker", secContext.requested_company_or_ticker ?? symbol),
      field("resolved_symbol when known", secContext.resolved_symbol ?? symbol),
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

  return [
    "<finny-subagent-context>",
    "Authoritative runtime context. It overrides conflicting task wording.",
    field("workspace_slug", workspace),
    field("workspace_name", humanNameOf(workspace)),
    field("requested_algorithm_name", context?.requested_algorithm_name ?? facts.requested_algorithm_name),
    field("requested_symbol", symbol),
    field("requested_interval", interval),
    field("requested_asset_class", assetClass),
    field("workspace_news_dir", newsDir),
    "",
    "Write at most one compact news/execution/provenance/risk note under `workspace_news_dir/body/`. Do not write headline rolls unless the parent prompt explicitly says `explicit_news_scan: true`.",
    "Do not write to `algos/_template/data/news` or any repo-local `algos/*/data/news` path.",
    "Return artifact_paths that point to files under `workspace_news_dir`.",
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

const BaseParameters = Schema.Struct(BaseParameterFields)

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

function taskJsonSchema(input: { background: boolean }): JSONSchema7 {
  const single = ToolJsonSchema.fromSchema(input.background ? SingleParameters : BaseParameters)
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
    state: "completed" | "error"
  }>
}

function isBatchParameters(params: TaskParameters): params is Extract<TaskParameters, { tasks: ReadonlyArray<unknown> }> {
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

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const runSingle = Effect.fn("TaskTool.executeSingle")(function* (
      params: SingleTaskParameters,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

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
      const workspace = yield* Effect.promise(async () => {
        const parentWorkspace = await getSessionWorkspace(ctx.sessionID).catch(() => null)
        const childWorkspace = await getSessionWorkspace(nextSession.id).catch(() => null)
        let workspace = parentWorkspace ?? childWorkspace
        if (!workspace && (params.subagent_type === "data_extractor" || params.subagent_type === "news_agent" || params.subagent_type === "researcher" || params.subagent_type === "sec_agent")) {
          workspace = (await bootstrapWorkspace(ctx.sessionID, params.prompt).catch(() => undefined))?.slug ?? null
        }
        if (workspace) {
          await bindSessionWorkspace(ctx.sessionID, workspace).catch(() => {})
          await bindSessionWorkspace(nextSession.id, workspace).catch(() => {})
        }
        return workspace
      })

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

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        if (params.subagent_type === "data_extractor" && !workspace) {
          return "BLOCKED: incomplete data request context: missing workspace_slug, allowed_data_dir"
        }
        let workspaceContext: WorkspaceRequestContext | undefined
        if (workspace && (params.subagent_type === "data_extractor" || params.subagent_type === "news_agent" || params.subagent_type === "researcher" || params.subagent_type === "sec_agent")) {
          workspaceContext = yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: ctx.sessionID,
              slug: workspace,
              prompt: params.prompt,
            }).catch(() => undefined),
          )
        }
        const validationContext =
          params.subagent_type === "data_extractor" ? dataExtractorValidationContext(workspaceContext) : workspaceContext
        if (params.subagent_type === "data_extractor") {
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
            if (result.info?.status === "completed")
              return inject("completed", result.info.output ?? EMPTY_SUBAGENT_RESULT_MARKER)
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
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
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
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

      if (params.tasks.length < 2 || params.tasks.length > 3) {
        return yield* Effect.fail(new Error("Task batch mode requires two or three foreground tasks"))
      }
      const subagentTypes = params.tasks.map((task) => task.subagent_type)
      if (new Set(subagentTypes).size !== subagentTypes.length) {
        return yield* Effect.fail(new Error("Task batch mode requires distinct subagent types"))
      }

      const existingWorkspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      if (
        !existingWorkspace &&
        subagentTypes.some((type) => ["data_extractor", "news_agent", "researcher", "sec_agent"].includes(type))
      ) {
        const bootstrapped = yield* Effect.promise(() =>
          bootstrapWorkspace(
            ctx.sessionID,
            params.tasks.map((task) => task.prompt).join("\n\n"),
          ).catch(() => undefined),
        )
        if (bootstrapped?.slug) {
          yield* Effect.promise(() => bindSessionWorkspace(ctx.sessionID, bootstrapped.slug).catch(() => {}))
        }
      }

      const exits = yield* Effect.all(
        params.tasks.map((task) => Effect.exit(runSingle(task, ctx))),
        { concurrency: "unbounded" },
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
          parentSessionId: ctx.sessionID,
          sessionId: childSubagents[0]?.sessionId ?? ctx.sessionID,
          batch: true,
          taskCount: results.length,
          subagentTypes,
          subagents: childSubagents,
        } satisfies TaskMetadata,
        output: renderBatchOutput(results),
      }
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: taskJsonSchema({ background: flags.experimentalBackgroundSubagents }),
      execute: (params: TaskParameters, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
