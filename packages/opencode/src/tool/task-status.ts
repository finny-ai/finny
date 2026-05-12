import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { TaskState } from "@/task/state"

const parameters = z.object({
  task_id: z.string().describe("Background task id to inspect."),
})

type Metadata = {
  found: boolean
  status?: TaskState.Status
}

export const TaskStatusTool = Tool.define<typeof parameters, Metadata, never>(
  "task_status",
  Effect.succeed({
    description: "Get the lifecycle status and latest summary for a background task created from the current session.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "task_status",
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

        return {
          title: `Task ${task.status}`,
          output: JSON.stringify(
            {
              id: task.id,
              description: task.description,
              subagentType: task.subagentType,
              mode: task.mode,
              status: task.status,
              startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
              finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
              resultSummary: task.resultSummary ?? null,
              lastError: task.lastError ?? null,
              updatedAt: new Date(task.updatedAt).toISOString(),
            },
            null,
            2,
          ),
          metadata: { found: true, status: task.status },
        }
      }),
  }),
)
