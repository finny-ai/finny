import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { Database } from "@opencode-ai/core/database/database"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"

// Todo.Info is still a zod schema (session/todo.ts). Inline the field shape
// here rather than referencing its `.shape` — the LLM-visible JSON Schema is
// identical, and it removes the last zod dependency from this tool.
const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

const WORKFLOW_TODOS = [
  ["Confirm request identity", "identity_confirmed"],
  ["Collect verified evidence", "evidence_ready"],
  ["Freeze research and validate candidate", "candidate_validated"],
  ["Plan the experiment", "experiment_planned"],
  ["Run strict qualification", "qualified"],
  ["Emit terminal workflow envelope", "terminal_complete"],
] as const

export function workflowTodoProjection(state: BuildWorkflowState): Todo.Info[] {
  const completed = new Set<string>()
  if (state.identityStatus === "confirmed") completed.add("identity_confirmed")
  if (
    state.evidenceRequirements
      .filter((requirement) => requirement.required)
      .every((requirement) =>
        state.evidence.some(
          (record) =>
            record.requirementId === requirement.id && record.kind === requirement.kind && record.status === "verified",
        ),
      )
  ) completed.add("evidence_ready")
  if (state.candidate) completed.add("candidate_validated")
  if (state.experimentPlan) completed.add("experiment_planned")
  if (state.backtest?.verdict === "recommended_for_paper" || state.terminal?.semanticSuccess) completed.add("qualified")
  if (state.terminal?.semanticSuccess) completed.add("terminal_complete")
  const failed = state.phase === "terminal_failed"
  return WORKFLOW_TODOS.map(([content, milestone]) => ({
    content,
    priority: "high",
    status:
      failed && !completed.has(milestone)
        ? "cancelled"
        : completed.has(milestone)
          ? "completed"
          : "pending",
  }))
}

export async function authoritativeWorkflowTodos(input: {
  agent: string
  modelTodos: Todo.Info[]
  load: () => Promise<BuildWorkflowState[]>
}): Promise<Todo.Info[]> {
  if (input.agent !== "build" && input.agent !== "finny") return input.modelTodos
  const workflows = await input.load()
  const workflow = workflows.find((item) => item.status === "active" || item.status === "blocked")
  if (!workflow) throw new Error("durable WorkflowRun is unavailable for lifecycle projection")
  return workflowTodoProjection(workflow)
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service | Database.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const database = yield* Database.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const resolved = yield* Effect.exit(
            Effect.promise(() =>
              authoritativeWorkflowTodos({
                agent: ctx.agent,
                modelTodos: params.todos,
                load: () =>
                  Effect.runPromise(
                    BuildWorkflowStore.listBySession(ctx.sessionID).pipe(
                      Effect.provideService(Database.Service, database),
                    ),
                  ),
              }),
            ),
          )
          if (resolved._tag === "Failure") {
            return {
              title: "Todo projection blocked",
              output: "BLOCKED: durable WorkflowRun state is unavailable; model-authored lifecycle status was not persisted.",
              metadata: { todos: [] },
            }
          }
          const todos = resolved.value

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos,
          })

          return {
            title: `${todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(todos, null, 2),
            metadata: {
              todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
