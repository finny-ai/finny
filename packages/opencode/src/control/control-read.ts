import { AlgorithmBuildApprovalChallengeTable } from "@opencode-ai/core/algorithm/build-workflow-schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TaskRunTable } from "@opencode-ai/core/task/sql"
import { and, desc, eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { BuildWorkflowObserve } from "@/algorithm/build-workflow/observe"
import { CampaignController, type Campaign } from "@/control-plane/campaign"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import type {
  AgentControlV1,
  CampaignControlV1,
  ControlSnapshotV1,
  CrucibleEventControlV1,
  CrucibleWorkflowControlV1,
  DomainHealthControlV1,
  TaskControlV1,
} from "./control-contracts"

const MAX_ROWS = 200
const MAX_CAMPAIGNS = 200

function countBy<T>(items: ReadonlyArray<T>, key: (item: T) => string) {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = key(item)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function health(domain: DomainHealthControlV1["domain"], result: Exit.Exit<unknown, unknown>): DomainHealthControlV1 {
  if (Exit.isSuccess(result)) return { domain, status: "fresh" }
  return {
    domain,
    status: "unavailable",
    message: Cause.pretty(result.cause),
  }
}

export interface Interface {
  readonly overview: () => Effect.Effect<ControlSnapshotV1>
  readonly agentCards: () => Effect.Effect<AgentControlV1[]>
  readonly taskCards: () => Effect.Effect<TaskControlV1[]>
  readonly crucibleCards: () => Effect.Effect<CrucibleWorkflowControlV1[]>
  readonly crucibleEvents: (workflowId: string) => Effect.Effect<CrucibleEventControlV1[]>
  readonly campaignCards: () => Effect.Effect<CampaignControlV1[]>
}

export class Service extends Context.Service<Service, Interface>()("@finny/ControlRead") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const statuses = yield* SessionStatus.Service
    const questions = yield* Question.Service
    const permissions = yield* Permission.Service
    const storage = yield* Storage.Service

    const taskCardsRaw = Effect.fn("ControlRead.taskCardsRaw")(function* () {
      const rows = yield* db
        .select()
        .from(TaskRunTable)
        .orderBy(desc(TaskRunTable.time_updated), desc(TaskRunTable.id))
        .limit(MAX_ROWS)
        .all()
      return rows.map(
        (row): TaskControlV1 => ({
          id: row.id,
          parentSessionID: row.parent_session_id,
          subagentType: row.subagent_type,
          mode: row.mode,
          status: row.status,
          ...(row.started_at === null ? {} : { startedAt: row.started_at }),
          ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
          ...(row.result_summary === null ? {} : { resultSummary: row.result_summary }),
          ...(row.last_error === null ? {} : { lastError: row.last_error }),
          createdAt: row.time_created,
          updatedAt: row.time_updated,
        }),
      )
    })

    const agentCardsRaw = Effect.fn("ControlRead.agentCardsRaw")(function* () {
      const [rows, taskRows, statusMap, pendingQuestions, pendingPermissions] = yield* Effect.all(
        [
          db
            .select()
            .from(SessionTable)
            .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
            .limit(MAX_ROWS)
            .all(),
          taskCardsRaw(),
          statuses.list(),
          questions.list(),
          permissions.list(),
        ],
        { concurrency: "unbounded" },
      )
      const childCounts = countBy(
        rows.filter((row) => row.parent_id !== null),
        (row) => row.parent_id!,
      )
      const tasksByParent = new Map<string, TaskControlV1[]>()
      for (const task of taskRows) {
        const list = tasksByParent.get(task.parentSessionID) ?? []
        list.push(task)
        tasksByParent.set(task.parentSessionID, list)
      }
      const questionCounts = countBy(pendingQuestions, (item) => item.sessionID)
      const permissionCounts = countBy(pendingPermissions, (item) => item.sessionID)
      const now = Date.now()

      return rows
        .filter((row) => row.parent_id === null)
        .map((row): AgentControlV1 => {
          const runtime = statusMap.get(row.id)
          const tasks = tasksByParent.get(row.id) ?? []
          const activeTask = tasks.find((task) => task.status === "running" || task.status === "queued")
          const blockedTask = tasks.find((task) => task.status === "blocked")
          const failedTask = tasks.find((task) => task.status === "failed")
          const pendingQuestionCount = questionCounts.get(row.id) ?? 0
          const pendingPermissionCount = permissionCounts.get(row.id) ?? 0
          const isWaiting = pendingQuestionCount > 0 || pendingPermissionCount > 0
          const status: AgentControlV1["status"] = isWaiting
            ? "blocked"
            : runtime?.type === "busy"
              ? "busy"
              : runtime?.type === "retry"
                ? "error"
                : runtime?.type === "preflight" || activeTask
                  ? "active"
                  : blockedTask
                    ? "blocked"
                    : failedTask
                      ? "error"
                      : "idle"
          const activity = isWaiting
            ? pendingQuestionCount > 0
              ? "Waiting for an answer"
              : "Waiting for permission"
            : runtime?.type === "preflight" || runtime?.type === "retry"
              ? runtime.message
              : activeTask
                ? `${activeTask.subagentType}: ${activeTask.status}`
                : failedTask?.lastError
          const startedAt = activeTask?.startedAt ?? activeTask?.createdAt
          const modelRef = row.model
            ? `${row.model.providerID}/${row.model.id}${row.model.variant ? `:${row.model.variant}` : ""}`
            : undefined
          const tokens =
            row.tokens_input + row.tokens_output + row.tokens_reasoning + row.tokens_cache_read + row.tokens_cache_write
          return {
            id: row.id,
            directory: row.directory,
            title: row.title,
            agent: row.agent ?? "default",
            ...(modelRef === undefined ? {} : { modelRef }),
            status,
            ...(activity === undefined ? {} : { currentActivity: activity }),
            ...(startedAt === undefined || status === "idle" ? {} : { elapsedMs: Math.max(0, now - startedAt) }),
            cost: row.cost,
            tokens,
            childCount: childCounts.get(row.id) ?? 0,
            taskCount: tasks.length,
            pendingQuestionCount,
            pendingPermissionCount,
            timeCreated: row.time_created,
            timeUpdated: row.time_updated,
          }
        })
    })

    const crucibleCardsRaw = Effect.fn("ControlRead.crucibleCardsRaw")(function* () {
      const [rows, pending] = yield* Effect.all([
        BuildWorkflowObserve.listRecentWorkflows({ limit: MAX_ROWS }).pipe(
          Effect.provideService(Database.Service, database),
        ),
        db
          .select({ workflowId: AlgorithmBuildApprovalChallengeTable.workflow_id })
          .from(AlgorithmBuildApprovalChallengeTable)
          .where(and(eq(AlgorithmBuildApprovalChallengeTable.status, "pending")))
          .all(),
      ])
      const pendingCounts = countBy(pending, (item) => item.workflowId)
      return rows.map((row): CrucibleWorkflowControlV1 => {
        const state = record(row.state)
        const candidate = state.candidate
        const backtest = state.backtest
        const terminal = state.terminal
        const pendingApprovalCount = pendingCounts.get(row.id) ?? 0
        const storedBlocker = state.blocker
        const blocker = pendingApprovalCount
          ? {
              ...record(storedBlocker),
              ...(storedBlocker === undefined
                ? { code: "approval_pending", message: "Workflow has pending approval challenges" }
                : {}),
              pendingApprovalCount,
            }
          : storedBlocker
        return {
          workflowId: row.id,
          sessionId: row.session_id,
          workspaceSlug: row.workspace_slug,
          stage: row.stage,
          status: row.status,
          phase: optionalString(state.phase) ?? "unknown",
          revision: row.revision,
          requestVersion: typeof state.requestVersion === "number" ? state.requestVersion : 0,
          ...(candidate === undefined ? {} : { candidate }),
          ...(backtest === undefined ? {} : { backtest }),
          ...(blocker === undefined ? {} : { blocker }),
          ...(terminal === undefined ? {} : { terminal }),
          updatedAt: row.time_updated,
        }
      })
    })

    const crucibleEventsRaw = Effect.fn("ControlRead.crucibleEventsRaw")(function* (workflowId: string) {
      const rows = yield* BuildWorkflowObserve.listWorkflowEvents(workflowId).pipe(
        Effect.provideService(Database.Service, database),
      )
      return rows.map((row): CrucibleEventControlV1 => {
        const payload = record(row.payload)
        const state = record(payload.state)
        const stage = optionalString(payload.stage) ?? optionalString(state.stage)
        const message =
          optionalString(payload.message) ??
          optionalString(payload.reason) ??
          optionalString(record(payload.blocker).message)
        const summary = optionalString(payload.summary) ?? message
        return {
          seq: row.seq,
          type: row.type,
          occurredAt: row.time_created,
          sourceKind: row.source_kind,
          ...(summary === undefined ? {} : { summary }),
          ...(stage === undefined ? {} : { stage }),
          ...(message === undefined ? {} : { message }),
        }
      })
    })

    const campaignCardsRaw = Effect.fn("ControlRead.campaignCardsRaw")(function* () {
      const controller = yield* Effect.serviceOption(CampaignController.Service)
      if (Option.isNone(controller)) return yield* Effect.fail(new Error("Campaign controller is unavailable"))
      const keys = (yield* storage.list(["campaign"])).slice(0, MAX_CAMPAIGNS)
      const campaigns = yield* Effect.forEach(keys, (key) => storage.read<Campaign>(key).pipe(Effect.option), {
        concurrency: 8,
      })
      return campaigns
        .flatMap((item) => (Option.isSome(item) ? [item.value] : []))
        .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .map(
          (item): CampaignControlV1 => ({
            id: item.id,
            goal: item.goal,
            agent: item.agent,
            status: item.status,
            rounds: item.rounds,
            candidateCount: item.candidates.length,
            eventsCount: item.events.length,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }),
        )
    })

    const agentCards = Effect.fn("ControlRead.agentCards")(function* () {
      return yield* agentCardsRaw().pipe(Effect.catchCause(() => Effect.succeed([])))
    })
    const taskCards = Effect.fn("ControlRead.taskCards")(function* () {
      return yield* taskCardsRaw().pipe(Effect.catchCause(() => Effect.succeed([])))
    })
    const crucibleCards = Effect.fn("ControlRead.crucibleCards")(function* () {
      return yield* crucibleCardsRaw().pipe(Effect.catchCause(() => Effect.succeed([])))
    })
    const crucibleEvents = Effect.fn("ControlRead.crucibleEvents")(function* (workflowId: string) {
      return yield* crucibleEventsRaw(workflowId).pipe(Effect.catchCause(() => Effect.succeed([])))
    })
    const campaignCards = Effect.fn("ControlRead.campaignCards")(function* () {
      return yield* campaignCardsRaw().pipe(Effect.catchCause(() => Effect.succeed([])))
    })

    const overview = Effect.fn("ControlRead.overview")(function* () {
      const [agentsResult, tasksResult, crucibleResult, campaignResult] = yield* Effect.all(
        [
          Effect.exit(agentCardsRaw()),
          Effect.exit(taskCardsRaw()),
          Effect.exit(crucibleCardsRaw()),
          Effect.exit(campaignCardsRaw()),
        ],
        { concurrency: "unbounded" },
      )
      return {
        schema: "finny.control_snapshot" as const,
        version: 1 as const,
        capturedAt: new Date().toISOString(),
        agents: Exit.isSuccess(agentsResult) ? agentsResult.value : [],
        tasks: Exit.isSuccess(tasksResult) ? tasksResult.value : [],
        crucible: Exit.isSuccess(crucibleResult) ? crucibleResult.value : [],
        campaigns: Exit.isSuccess(campaignResult) ? campaignResult.value : [],
        health: [
          health("agents", Exit.isFailure(agentsResult) ? agentsResult : tasksResult),
          health("crucible", crucibleResult),
          health("campaign", campaignResult),
        ],
      }
    })

    return Service.of({ overview, agentCards, taskCards, crucibleCards, crucibleEvents, campaignCards })
  }),
)

export * as ControlReadService from "./control-read"
