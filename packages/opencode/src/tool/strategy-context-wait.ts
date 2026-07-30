import { Database } from "@opencode-ai/core/database/database"
import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { StrategyContext } from "@/task/strategy-context"
import { TaskState } from "@/task/state"
import * as Tool from "./tool"

const Parameters = Schema.Struct({})

type Metadata = {
  captured: number
  completed: number
  pendingContext: string[]
}

type WaitedTask = {
  task: TaskState.Info
  status?: BackgroundJob.Status
  output?: string
  error?: string
  waitable: boolean
}

const EMPTY_CONTEXT_RESULT = "BLOCKED: context task settled without a usable result."

function resultStatus(output: string): Extract<TaskState.Status, "blocked" | "completed"> {
  return /\bBLOCKED:/.test(output) ? TaskState.Status.blocked : TaskState.Status.completed
}

function summary(text: string) {
  const trimmed = text.trim()
  return trimmed.length > 4_000 ? trimmed.slice(0, 4_000) : trimmed
}

function renderTaskResult(result: WaitedTask, state: TaskState.Status) {
  const text =
    result.output ??
    result.error ??
    result.task.resultSummary ??
    result.task.lastError ??
    (result.waitable
      ? "Task settled without a result body."
      : "The durable task is still active, but its process-local background job is unavailable.")
  return [
    `<context_task id="${result.task.id}" subagent_type="${result.task.subagentType}" state="${state}">`,
    text,
    "</context_task>",
  ].join("\n")
}

export const StrategyContextWaitTool = Tool.define<
  typeof Parameters,
  Metadata,
  Database.Service | BackgroundJob.Service
>(
  "finny_strategy_context_wait",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    return {
      description: [
        "Wait once for every active strategy-context task from this session.",
        "This is a blocking barrier, not a status poll: it returns only after the captured background jobs settle, preserves their result order, and releases strategy synthesis only when no context task remains active.",
      ].join(" "),
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const captured = yield* Effect.promise(() =>
            StrategyContext.pendingTasks(ctx.sessionID, database, ctx.messages),
          )
          if (captured.length === 0) {
            return {
              title: "Strategy context already settled",
              output: "No active strategy-context tasks remain. Strategy synthesis may continue.",
              metadata: { captured: 0, completed: 0, pendingContext: [] },
            }
          }

          yield* ctx.ask({
            permission: "task",
            patterns: [...new Set(captured.map((task) => task.subagentType))],
            always: ["*"],
            metadata: {
              task_ids: captured.map((task) => task.id),
              wait: true,
            },
          })

          // Wait for the complete captured set before finalizing any member.
          // That keeps the synthesis gate closed when one sibling finishes
          // earlier than the others.
          const waited = yield* Effect.forEach(
            captured,
            (task) =>
              background.wait({ id: task.id }).pipe(
                Effect.map(
                  (result): WaitedTask => ({
                    task,
                    status: result.info?.status,
                    output: result.info?.output,
                    error: result.info?.error,
                    waitable: result.info !== undefined,
                  }),
                ),
              ),
            { concurrency: "unbounded" },
          )

          yield* Effect.forEach(
            waited,
            (result) => {
              if (!result.waitable) return Effect.void
              const status =
                result.status === "error"
                  ? TaskState.Status.failed
                  : result.status === "cancelled"
                    ? TaskState.Status.cancelled
                    : resultStatus(result.output ?? EMPTY_CONTEXT_RESULT)
              return Effect.promise(() =>
                TaskState.finalizeActive(
                  result.task.id,
                  {
                    status,
                    resultSummary:
                      result.status === "completed" ? summary(result.output ?? EMPTY_CONTEXT_RESULT) : null,
                    lastError: result.error ?? null,
                  },
                  database,
                ),
              ).pipe(Effect.asVoid)
            },
            { concurrency: "unbounded", discard: true },
          )

          const remaining = yield* Effect.promise(() =>
            StrategyContext.pendingTasks(ctx.sessionID, database, ctx.messages),
          )
          const latest = yield* Effect.forEach(
            waited,
            (result) =>
              Effect.promise(() => TaskState.get(result.task.id, database)).pipe(
                Effect.map((task) => ({ result, state: task?.status ?? result.task.status })),
              ),
            { concurrency: "unbounded" },
          )
          const output = [
            remaining.length === 0
              ? `Strategy context settled after ${captured.length} task${captured.length === 1 ? "" : "s"}.`
              : "BLOCKED: strategy context could not be fully awaited because an active task has no waitable runtime job.",
            ...latest.map(({ result, state }) => renderTaskResult(result, state)),
            ...(remaining.length === 0
              ? ["All captured context results are now ordered before strategy synthesis and writes."]
              : [
                  `Still pending: ${remaining.map((task) => `${task.subagentType}:${task.id}`).join(", ")}.`,
                  "Do not poll or synthesize. Restart the unavailable context task from a healthy runtime.",
                ]),
          ].join("\n")

          return {
            title: remaining.length === 0 ? "Strategy context settled" : "Strategy context wait unavailable",
            output,
            metadata: {
              captured: captured.length,
              completed: latest.filter(({ state }) => TaskState.isTerminal(state)).length,
              pendingContext: remaining.map((task) => `${task.subagentType}:${task.id}`),
            },
          }
        }),
    }
  }),
)
