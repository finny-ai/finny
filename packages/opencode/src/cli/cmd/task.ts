import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { TaskState } from "@/task/state"

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function formatTask(task: TaskState.Info) {
  return {
    id: task.id,
    parentSessionID: task.parentSessionID,
    description: task.description,
    subagentType: task.subagentType,
    mode: task.mode,
    status: task.status,
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
    finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
    resultSummary: task.resultSummary ?? null,
    lastError: task.lastError ?? null,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
  }
}

export const TaskCommand = cmd({
  command: "task",
  describe: "manage background subagent tasks",
  builder: (yargs) => yargs.command(TaskListCommand).command(TaskShowCommand).demandCommand(),
  async handler() {},
})

const TaskListCommand = effectCmd({
  command: "list <sessionID>",
  describe: "list background tasks launched from a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      type: "string",
      demandOption: true,
      describe: "parent session ID",
    }),
  handler: Effect.fn("Cli.task.list")(function* (args) {
    const tasks = yield* Effect.promise(() => TaskState.listByParent(args.sessionID))
    print(tasks.map(formatTask))
  }),
})

const TaskShowCommand = effectCmd({
  command: "show <taskID>",
  describe: "show the lifecycle status and latest summary for a task",
  builder: (yargs) =>
    yargs.positional("taskID", {
      type: "string",
      demandOption: true,
      describe: "background task ID",
    }),
  handler: Effect.fn("Cli.task.show")(function* (args) {
    const task = yield* Effect.promise(() => TaskState.get(args.taskID))
    if (!task) return yield* fail(`Task not found: ${args.taskID}`)
    print(formatTask(task))
  }),
})
