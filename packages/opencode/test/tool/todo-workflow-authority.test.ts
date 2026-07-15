import { describe, expect, test } from "bun:test"
import { createBuildWorkflow, transition } from "@/algorithm/build-workflow/state"
import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"
import { authoritativeWorkflowTodos, workflowTodoProjection } from "@/tool/todo"

function workflow(): BuildWorkflowState {
  return createBuildWorkflow({
    workflowId: "wf_todo",
    sessionId: "ses_todo",
    workspaceSlug: "spy-todo",
    intent: "build",
    identity: {
      symbols: { value: ["SPY"], source: { kind: "user_message", messageId: "msg_todo" } },
    },
  })
}

describe("durable workflow todo authority", () => {
  test("fails closed on durable-store failure instead of accepting model lifecycle state", async () => {
    const modelTodos = [{ content: "Run strict qualification", status: "completed", priority: "high" }]
    await expect(
      authoritativeWorkflowTodos({
        agent: "build",
        modelTodos,
        load: async () => {
          throw new Error("database unavailable")
        },
      }),
    ).rejects.toThrow("database unavailable")
  })

  test("does not project strict qualification complete for an early terminal failure", () => {
    const decision = transition(workflow(), {
      id: "evt_early_failure",
      type: "workflow.failed",
      occurredAt: 2,
      source: { actor: "system" },
      reason: "provider failed before evidence",
    })
    if (!decision.allowed) throw new Error(decision.message)
    const todos = workflowTodoProjection(decision.state)
    expect(todos.find((item) => item.content === "Run strict qualification")?.status).toBe("cancelled")
    expect(todos.find((item) => item.content === "Emit terminal workflow envelope")?.status).toBe("cancelled")
  })

  test("distinguishes strict-blocked from qualified terminal completion", () => {
    const blocked = {
      ...workflow(),
      phase: "strict_blocked" as const,
      terminal: {
        workflowRunId: "wf_todo",
        requestVersion: 1,
        phase: "strict_blocked" as const,
        classification: "blocked" as const,
        semanticSuccess: false,
        semanticExitCode: 2 as const,
        resumeToken: workflow().resumeToken,
        revision: 2,
      },
    }
    expect(workflowTodoProjection(blocked).find((item) => item.content === "Run strict qualification")?.status).toBe(
      "pending",
    )

    const complete = {
      ...blocked,
      phase: "terminal_complete" as const,
      terminal: { ...blocked.terminal, phase: "terminal_complete" as const, classification: "complete" as const, semanticSuccess: true, semanticExitCode: 0 as const },
    }
    const todos = workflowTodoProjection(complete)
    expect(todos.find((item) => item.content === "Run strict qualification")?.status).toBe("completed")
    expect(todos.find((item) => item.content === "Emit terminal workflow envelope")?.status).toBe("completed")
  })
})
