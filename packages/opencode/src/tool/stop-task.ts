import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { TaskState } from "@/task/state"
import { SessionPrompt } from "@/session/prompt"
import { Analytics } from "@/analytics/tracker"

const parameters = z.object({
  task_id: z.string().describe("Background task id to cancel."),
})

type Metadata = {
  found: boolean
  status?: TaskState.Status
  cancelled?: boolean
}

export const StopTaskTool = Tool.define<typeof parameters, Metadata, never>(
  "stop_task",
  Effect.succeed({
    description:
      "Stop a background task created from the current session. Running children are cancelled; finished tasks return their current state.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "stop_task",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const task = await TaskState.get(params.task_id)
        if (!task || task.parentSessionID !== ctx.sessionID) {
          return {
            title: "Task not found",
            output: "No background task from this session matched the provided task_id.",
            metadata: { found: false },
          }
        }

        if (TaskState.isTerminal(task.status)) {
          return {
            title: `Task already ${task.status}`,
            output: JSON.stringify(
              {
                task_id: task.id,
                status: task.status,
                finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
              },
              null,
              2,
            ),
            metadata: { found: true, status: task.status, cancelled: false },
          }
        }

        await SessionPrompt.cancel(task.id)
        const cancelled = await TaskState.cancel(task.id)
        // TaskState.cancel can return undefined if the row vanished between
        // the get() above and the transaction (rare but possible on concurrent
        // session-delete). Don't claim success or emit a cancelled analytics
        // event in that case — surface the actual latest state instead.
        if (!cancelled) {
          const latest = await TaskState.get(task.id)
          return {
            title: "Task cancellation not confirmed",
            output: JSON.stringify(
              {
                task_id: task.id,
                status: latest?.status ?? task.status,
              },
              null,
              2,
            ),
            metadata: { found: true, status: latest?.status ?? task.status, cancelled: false },
          }
        }
        Analytics.track({
          eventType: "task",
          eventName: "task.background.cancelled",
          sessionId: ctx.sessionID,
          metadata: { taskId: task.id, priorStatus: task.status },
        })

        return {
          title: "Task cancelled",
          output: JSON.stringify(
            {
              task_id: task.id,
              status: cancelled.status,
            },
            null,
            2,
          ),
          metadata: { found: true, status: cancelled.status, cancelled: true },
        }
      }),
  }),
)
