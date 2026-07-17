import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { TaskState } from "@/task/state"
import { Database } from "@opencode-ai/core/database/database"

const parameters = z.object({})

type Metadata = {
  count: number
}

export const ListTasksTool = Tool.define<typeof parameters, Metadata, Database.Service>(
  "list_tasks",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "List background tasks launched from the current session. Returns task ids, lifecycle status, and the latest summary.",
      parameters,
      execute: (_params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.promise(async () => {
          await ctx.ask({
            permission: "list_tasks",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const tasks = (await TaskState.listByParent(ctx.sessionID, database)).map((task) => ({
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
          }))

          return {
            title:
              tasks.length === 0
                ? "No background tasks"
                : `${tasks.length} background task${tasks.length === 1 ? "" : "s"}`,
            output: JSON.stringify(tasks, null, 2),
            metadata: { count: tasks.length },
          }
        }),
    }
  }),
)
