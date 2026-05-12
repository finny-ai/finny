import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { Effect } from "effect"
import { Log } from "@/util/log"
import { Inject } from "@/cron/inject"
import { TaskState } from "@/task/state"
import { BackgroundTaskBlockedError } from "@/task/error"
import { Permission } from "@/permission"
import type { ModelID, ProviderID } from "@/provider/schema"
import { Analytics } from "@/analytics/tracker"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  promptAsync(
    input: SessionPrompt.PromptInput,
    lifecycle: {
      onError(error: unknown): Promise<void> | void
      onResult(result: MessageV2.WithParts): Promise<void> | void
    },
  ): Effect.Effect<void>
}

type Metadata = {
  sessionId: SessionID
  model: {
    modelID: ModelID
    providerID: ProviderID
  }
  mode: "foreground" | "background"
  status?: TaskState.Status
}

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  mode: z.enum(["foreground", "background"]).default("foreground").optional(),
})

export const TaskTool = Tool.define<typeof parameters, Metadata, Agent.Service | Config.Service | Session.Service>(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      const log = Log.create({ service: "tool.task" })

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

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")
      const mode = params.mode ?? "foreground"

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
          mode,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()
      const backgroundPrompt = [
        "<system-reminder>",
        "You are running as a background subagent.",
        "Do not ask the user direct questions and do not wait for approvals.",
        'If you need clarification, permission, or a denied tool blocks progress, stop and reply with one concise line that starts with `BLOCKED:`.',
        "</system-reminder>",
        "",
        params.prompt,
      ].join("\n")

      function cancel() {
        ops.cancel(nextSession.id)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const promptText = mode === "background" ? backgroundPrompt : params.prompt
            const parts = yield* ops.resolvePromptParts(promptText)
            const promptInput: SessionPrompt.PromptInput = {
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...(mode === "background" ? { question: false } : {}),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
              ...(mode === "background" ? { background: { disallowInteraction: true } } : {}),
            }

            if (mode === "background") {
              const existing = params.task_id ? yield* Effect.promise(() => TaskState.get(nextSession.id)) : undefined
              if (existing?.status === TaskState.Status.running) {
                return yield* Effect.fail(
                  new Error(`Task ${nextSession.id} is already running. Wait for it to finish before resuming.`),
                )
              }
              if (existing?.status === TaskState.Status.blocked) {
                return yield* Effect.fail(
                  new Error(
                    `Task ${nextSession.id} is blocked: ${existing.resultSummary ?? "no detail"}. Resolve the blocker before resuming.`,
                  ),
                )
              }

              yield* Effect.promise(() =>
                TaskState.upsert({
                  id: nextSession.id,
                  parentSessionID: ctx.sessionID,
                  description: params.description,
                  subagentType: params.subagent_type,
                  mode,
                  status: TaskState.Status.queued,
                }),
              )
              yield* Effect.promise(() => TaskState.markRunning(nextSession.id))
              Analytics.track({
                eventType: "task",
                eventName: "task.background.started",
                sessionId: ctx.sessionID,
                metadata: {
                  taskId: nextSession.id,
                  subagentType: params.subagent_type,
                  resumed: !!params.task_id,
                  description: params.description,
                  prompt: params.prompt,
                },
              })

              yield* ops.promptAsync(promptInput, {
                onResult: async (result) => {
                  const text = result.parts.findLast((item) => item.type === "text")?.text?.trim() ?? ""
                  if (text.startsWith("BLOCKED:")) {
                    const reason = text.slice("BLOCKED:".length).trim() || "Background task requested attention."
                    const state = await TaskState.finalizeActive(nextSession.id, {
                      status: TaskState.Status.blocked,
                      resultSummary: reason,
                    })
                    if (state?.status === TaskState.Status.blocked) {
                      await Inject.post(
                        ctx.sessionID,
                        Inject.formatTaskBlocked({
                          description: params.description,
                          reason,
                        }),
                        { title: `Background task blocked: ${params.description}` },
                      )
                      Analytics.track({
                        eventType: "task",
                        eventName: "task.background.blocked",
                        sessionId: ctx.sessionID,
                        metadata: {
                          taskId: nextSession.id,
                          description: params.description,
                          reason,
                          source: "result_prefix",
                        },
                      })
                    }
                    return
                  }

                  const state = await TaskState.finalizeActive(nextSession.id, {
                    status: TaskState.Status.completed,
                    resultSummary: text,
                  })
                  if (state?.status === TaskState.Status.completed) {
                    await Inject.post(
                      ctx.sessionID,
                      Inject.formatTaskCompleted({
                        description: params.description,
                        text,
                      }),
                      { title: `Background task completed: ${params.description}` },
                    )
                    Analytics.track({
                      eventType: "task",
                      eventName: "task.background.completed",
                      sessionId: ctx.sessionID,
                      metadata: {
                        taskId: nextSession.id,
                        description: params.description,
                        result: text,
                      },
                    })
                  }
                },
                onError: async (error) => {
                  const current = await TaskState.get(nextSession.id)
                  if (!current || TaskState.isTerminal(current.status)) return

                  if (
                    error instanceof BackgroundTaskBlockedError ||
                    error instanceof Permission.DeniedError ||
                    error instanceof Permission.CorrectedError ||
                    error instanceof Permission.RejectedError
                  ) {
                    const reason = error.message || "Background task needs parent attention."
                    const state = await TaskState.finalizeActive(nextSession.id, {
                      status: TaskState.Status.blocked,
                      resultSummary: reason,
                    })
                    if (state?.status === TaskState.Status.blocked) {
                      await Inject.post(
                        ctx.sessionID,
                        Inject.formatTaskBlocked({
                          description: params.description,
                          reason,
                        }),
                        { title: `Background task blocked: ${params.description}` },
                      )
                      Analytics.track({
                        eventType: "task",
                        eventName: "task.background.blocked",
                        sessionId: ctx.sessionID,
                        metadata: {
                          taskId: nextSession.id,
                          description: params.description,
                          reason,
                          errorClass: error.constructor.name,
                          source: "exception",
                        },
                      })
                    }
                    return
                  }

                  const errText = error instanceof Error ? error.message : String(error)
                  const state = await TaskState.finalizeActive(nextSession.id, {
                    status: TaskState.Status.failed,
                    lastError: errText,
                    resultSummary: errText,
                  })
                  if (state?.status === TaskState.Status.failed) {
                    await Inject.post(
                      ctx.sessionID,
                      Inject.formatTaskFailed({
                        description: params.description,
                        error: errText,
                      }),
                      { title: `Background task failed: ${params.description}` },
                    )
                    Analytics.track({
                      eventType: "task",
                      eventName: "task.background.failed",
                      sessionId: ctx.sessionID,
                      metadata: {
                        taskId: nextSession.id,
                        description: params.description,
                        errorMessage: errText,
                        errorClass: error instanceof Error ? error.constructor.name : "unknown",
                        stack: error instanceof Error ? error.stack ?? null : null,
                      },
                    })
                  }
                  log.warn("task.background.failed", {
                    taskID: nextSession.id,
                    parentSessionID: ctx.sessionID,
                    error: errText,
                  })
                },
              })

              return {
                title: params.description,
                metadata: {
                  sessionId: nextSession.id,
                  model,
                  mode,
                  status: TaskState.Status.running,
                },
                output: [
                  `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                  `mode: ${mode}`,
                  `status: ${TaskState.Status.running}`,
                ].join("\n"),
              }
            }

            const result = yield* ops.prompt(promptInput)

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
                mode,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
