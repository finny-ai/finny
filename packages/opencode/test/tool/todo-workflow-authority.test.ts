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

  test("preserves the model plan and appends missing durable workflow milestones", async () => {
    const state = workflow()
    const modelTodos = [
      { content: "Write mission.md", status: "in_progress", priority: "high" },
      { content: "Save and validate the strategy", status: "pending", priority: "high" },
      { content: "Run the requested backtest", status: "pending", priority: "high" },
    ]
    const todos = await authoritativeWorkflowTodos({
      agent: "finny",
      modelTodos,
      load: async () => [state],
    })
    expect(todos.slice(0, modelTodos.length)).toEqual(modelTodos)
    expect(todos.slice(modelTodos.length)).toEqual(workflowTodoProjection(state))
  })

  test("keeps durable workflow authority for explicitly named lifecycle milestones", async () => {
    const state = workflow()
    const modelTodos = [
      { content: "Confirm request identity", status: "completed", priority: "high" },
      { content: "Write edge_analysis.md", status: "in_progress", priority: "high" },
    ]
    const todos = await authoritativeWorkflowTodos({
      agent: "build",
      modelTodos,
      load: async () => [state],
    })
    const authoritativeStatus = workflowTodoProjection(state).find(
      (item) => item.content === "Confirm request identity",
    )?.status
    expect(authoritativeStatus).toBeDefined()
    expect(todos.slice(0, 2)).toEqual([
      { ...modelTodos[0]!, status: authoritativeStatus! },
      modelTodos[1]!,
    ])
  })

  test("cannot present arbitrary custom todos as all complete while failed gates remain active", async () => {
    const state = {
      ...workflow(),
      phase: "candidate_validated" as const,
      stage: "backtested" as const,
      evidence: [
        {
          id: "evidence_market",
          requirementId: "market_data:SPY",
          kind: "market_data" as const,
          status: "verified" as const,
          issues: [],
        },
      ],
      candidate: {
        algorithmId: "algo_1",
        name: "spy-strategy",
        version: 1,
        strategyHash: "strategy_hash",
        configHash: "config_hash",
        conceptId: "concept_1",
      },
      backtest: {
        runId: "run_failed",
        strategyHash: "strategy_hash",
        configHash: "config_hash",
        dataHash: "data_hash",
        engineHash: "engine_hash",
        hashes: {
          strategyHash: "strategy_hash",
          savedConfigHash: "config_hash",
          effectiveConfigHash: "config_hash",
          dataHash: "data_hash",
          manifestHash: "manifest_hash",
          engineHash: "engine_hash",
          windowHash: "window_hash",
        },
        identityHash: "identity_hash",
        verdict: "failed" as const,
      },
    }
    const modelTodos = [
      { content: "Run unified backtest gauntlet versus buy-and-hold", status: "completed", priority: "high" },
      { content: "Summarize whether it beat the user's gates", status: "completed", priority: "high" },
    ]
    const todos = await authoritativeWorkflowTodos({ agent: "finny", modelTodos, load: async () => [state] })
    expect(todos.slice(0, 2)).toEqual(modelTodos)
    expect(todos.some((item) => item.status !== "completed")).toBe(true)
    expect(todos.find((item) => item.content === "Run strict qualification")?.status).toBe("pending")
    expect(todos.find((item) => item.content === "Emit terminal workflow envelope")?.status).toBe("pending")
  })

  test("projects an evidence-optional exploratory backtest before strict workflow begins", () => {
    const todos = workflowTodoProjection(workflow())
    expect(todos.map((item) => item.content)).toEqual([
      "Confirm request identity",
      "Run exploratory backtest (verified evidence optional)",
      "Review exploratory backtest results",
    ])
    expect(todos.find((item) => item.content.startsWith("Run exploratory"))?.status).toBe("pending")
    expect(todos.some((item) => item.content === "Collect verified evidence")).toBe(false)
  })

  test("completes the exploratory projection after an accepted terminal backtest", () => {
    const state = {
      ...workflow(),
      attempts: [
        {
          id: "attempt_research",
          idempotencyKey: "backtest:finish:accepted",
          fingerprint: "research-fingerprint",
          operation: "finny_backtest:finish",
          outcome: "accepted" as const,
          lifecycle: "terminal" as const,
          requiredChanges: [],
          requestVersion: 1,
          artifactIds: ["run_research"],
          evidenceIds: [],
          trialIds: [],
          createdAt: 2,
        },
      ],
    }
    const todos = workflowTodoProjection(state)
    expect(todos.find((item) => item.content.startsWith("Run exploratory"))?.status).toBe("completed")
    expect(todos.find((item) => item.content === "Review exploratory backtest results")?.status).toBe("completed")
  })

  test("switches to strict lifecycle projection once verified evidence is recorded", () => {
    const state = {
      ...workflow(),
      evidence: [
        {
          id: "evidence_market",
          requirementId: "market_data:SPY",
          kind: "market_data" as const,
          status: "verified" as const,
          issues: [],
        },
      ],
    }
    const todos = workflowTodoProjection(state)
    expect(todos.some((item) => item.content === "Collect verified evidence")).toBe(true)
    expect(todos.some((item) => item.content.startsWith("Run exploratory"))).toBe(false)
  })

  test("cancels unfinished exploratory work after an early terminal failure", () => {
    const decision = transition(workflow(), {
      id: "evt_early_failure",
      type: "workflow.failed",
      occurredAt: 2,
      source: { actor: "system" },
      reason: "provider failed before evidence",
    })
    if (!decision.allowed) throw new Error(decision.message)
    const todos = workflowTodoProjection(decision.state)
    expect(todos.find((item) => item.content.startsWith("Run exploratory"))?.status).toBe("cancelled")
    expect(todos.find((item) => item.content === "Review exploratory backtest results")?.status).toBe("cancelled")
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
