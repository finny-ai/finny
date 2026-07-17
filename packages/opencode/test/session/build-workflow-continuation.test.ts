import { describe, expect, test } from "bun:test"
import { createBuildWorkflow } from "@/algorithm/build-workflow/state"
import type { BuildWorkflowState, ExperimentAttempt } from "@/algorithm/build-workflow/types"
import {
  buildWorkflowContinuationReminder,
  hasParentOverlapActionAfterContextLaunch,
  hasPresentableResearchResult,
  isYieldingControlToUser,
  MIN_FAILED_METRIC_TRIALS,
  shouldResumeInterruptedWorkflow,
} from "@/session/build-workflow-continuation"

function failedWorkflow(trials = 1): BuildWorkflowState {
  const state = createBuildWorkflow({
    workflowId: "wf_continue_v2",
    sessionId: "ses_continue_v2",
    workspaceSlug: "btc-continue-v2",
    intent: "build",
    identity: {
      symbols: { value: ["BTC.USD"], source: { kind: "user_message", messageId: "msg_user" } },
    },
  })
  const attempts: ExperimentAttempt[] = Array.from({ length: trials }, (_, index) => ({
    id: `trial_${index}`,
    experimentId: state.workflowId,
    conceptId: `concept_${index}`,
    replayKey: `replay_${index}`,
    strategyHash: `strategy_${index}`,
    savedConfigHash: `config_${index}`,
    datasetHash: "dataset",
    windowHash: "window",
    gridTrials: 1,
    outcome: "metrics",
    runId: `run_${index}`,
    createdAt: index + 1,
  }))
  return {
    ...state,
    status: "active",
    stage: "backtested",
    phase: "candidate_validated",
    candidate: {
      algorithmId: "algo_continue_v2",
      name: "continue-v2",
      version: 1,
      strategyHash: "strategy",
      configHash: "config",
      conceptId: `concept_${Math.max(0, trials - 1)}`,
    },
    experimentAttempts: attempts,
    backtest: {
      runId: `run_${trials - 1}`,
      strategyHash: "strategy",
      configHash: "config",
      dataHash: "dataset",
      engineHash: "engine",
      hashes: {
        strategyHash: "strategy",
        savedConfigHash: "config",
        effectiveConfigHash: "config",
        dataHash: "dataset",
        manifestHash: "manifest",
        engineHash: "engine",
        windowHash: "window",
      },
      identityHash: "identity",
      verdict: "failed",
    },
  }
}

function withVerdict(
  workflow: BuildWorkflowState,
  verdict: NonNullable<BuildWorkflowState["backtest"]>["verdict"],
): BuildWorkflowState {
  return {
    ...workflow,
    backtest: workflow.backtest ? { ...workflow.backtest, verdict } : undefined,
  }
}

describe("active Build workflow continuation", () => {
  test("only a newer real user continuation resumes an interrupted workflow", () => {
    const workflow = {
      ...failedWorkflow(1),
      status: "blocked",
      updatedAt: 2_000,
      blocker: {
        code: "workflow_interrupted",
        message: "interrupted",
        fingerprint: "old-fingerprint",
        requiredChanges: ["resume"],
        eventId: "evt_interrupted",
      },
    } as BuildWorkflowState
    expect(
      shouldResumeInterruptedWorkflow({ workflow, lastUserCreatedAt: 2_001, hasRealContinuationText: true }),
    ).toBeTrue()
    expect(
      shouldResumeInterruptedWorkflow({ workflow, lastUserCreatedAt: 2_000, hasRealContinuationText: true }),
    ).toBeFalse()
    expect(
      shouldResumeInterruptedWorkflow({ workflow, lastUserCreatedAt: 2_001, hasRealContinuationText: false }),
    ).toBeFalse()
  })

  test("failed v1 forces an automatic v2 continuation instead of a final answer", () => {
    const reminder = buildWorkflowContinuationReminder({ workflow: failedWorkflow(1), pendingContextTasks: 0 })
    expect(reminder).toContain("Do not stop with a narrative-only summary after a failed or missing metric trial")
    expect(reminder).toContain("presentable non-failed result")
    expect(reminder).toContain("recommended_for_paper final review packet")
    expect(reminder).toContain("next response MUST call finny_algorithm_save")
    expect(reminder).toContain("next required action is finny_backtest")
    expect(reminder).toContain("concept_exhausted is not an admissible outcome")
    expect(reminder).toContain("Completed metric trials: 1")
    expect(reminder).toContain("User control wins")
  })

  test("a newly saved candidate requires backtest next rather than another save or a narrative", () => {
    const workflow = { ...failedWorkflow(4), backtest: undefined }
    const reminder = buildWorkflowContinuationReminder({ workflow, pendingContextTasks: 0 })
    expect(reminder).toContain("next response MUST call finny_backtest now for saved candidate v1")
    expect(reminder).toContain("narrative-only output is invalid")
    expect(reminder).toContain("Do not save another candidate")
    expect(reminder).not.toContain("next response MUST call finny_algorithm_save")
  })

  test("four failed metric trials cannot terminate as concept exhausted", () => {
    const reminder = buildWorkflowContinuationReminder({ workflow: failedWorkflow(4), pendingContextTasks: 0 })
    expect(reminder).toContain("Completed metric trials: 4")
    expect(reminder).toContain("concept_exhausted is not an admissible outcome")
    expect(reminder).toContain("next response MUST call finny_algorithm_save")
  })

  test("requires a useful parent action after launching a background context batch", () => {
    const reminder = buildWorkflowContinuationReminder({
      workflow: failedWorkflow(1),
      pendingContextTasks: 2,
      parentOverlapComplete: false,
    })
    expect(reminder).toContain("non-overlapping parent preparation action")
    expect(reminder).toContain("Do not synthesize strategy evidence")
  })

  test("allows the parent to yield after useful overlap while background context is still running", () => {
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(1),
        pendingContextTasks: 2,
        parentOverlapComplete: true,
      }),
    ).toBeUndefined()
  })

  test("forces a fresh exact-role retry before generic build iteration when evidence is still unverified", () => {
    const reminder = buildWorkflowContinuationReminder({
      workflow: failedWorkflow(1),
      pendingContextTasks: 0,
      unverifiedContextRoles: ["news_agent"],
    })
    expect(reminder).toContain("still lacks verified context evidence for: news_agent")
    expect(reminder).toContain("Call task_run now for news_agent without task_id")
    expect(reminder).toContain("Do not synthesize, save, backtest")
    expect(reminder).not.toContain("materially corrected or alternative saved candidate")
  })

  test("rotates to a fresh concept and keeps autonomous iteration active at the former trial boundary", () => {
    const reminder = buildWorkflowContinuationReminder({
      workflow: failedWorkflow(MIN_FAILED_METRIC_TRIALS),
      pendingContextTasks: 0,
    })
    expect(reminder).toContain(`Completed metric trials: ${MIN_FAILED_METRIC_TRIALS}`)
    expect(reminder).toContain("fresh strategy concept family")
    expect(reminder).toContain("next response MUST call finny_algorithm_save")
    expect(reminder).toContain("Trial count does not authorize a terminal failure")
  })

  test("continues save/backtest enforcement beyond five failed metric trials", () => {
    const reminder = buildWorkflowContinuationReminder({ workflow: failedWorkflow(8), pendingContextTasks: 0 })
    expect(reminder).toContain("Completed metric trials: 8")
    expect(reminder).toContain("fresh strategy concept family")
    expect(reminder).toContain("concept_exhausted is not an admissible outcome while the workflow remains active")
  })

  test("allows the explicit three-save-attempt hard boundary", () => {
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(1),
        pendingContextTasks: 0,
        saveHardBoundary: true,
      }),
    ).toBeUndefined()
  })

  test("stops auto-iteration once a presentable research_only champion exists", () => {
    const workflow = withVerdict(failedWorkflow(3), "research_only")
    expect(hasPresentableResearchResult(workflow)).toBeTrue()
    expect(
      buildWorkflowContinuationReminder({
        workflow,
        pendingContextTasks: 0,
        assistantText: "Hourly champion is ready for paper-trading watchlist deployment on IBKR.",
      }),
    ).toBeUndefined()
  })

  test("stops auto-iteration once a presentable candidate champion exists", () => {
    const workflow = withVerdict(failedWorkflow(2), "candidate")
    expect(hasPresentableResearchResult(workflow)).toBeTrue()
    expect(buildWorkflowContinuationReminder({ workflow, pendingContextTasks: 0 })).toBeUndefined()
  })

  test("keeps iterating only while the latest metric verdict is failed", () => {
    expect(hasPresentableResearchResult(failedWorkflow(1))).toBeFalse()
    expect(buildWorkflowContinuationReminder({ workflow: failedWorkflow(1), pendingContextTasks: 0 })).toBeDefined()
  })

  test("disables auto-iteration entirely in offline harness mode", () => {
    const prior = process.env.FINNY_HARNESS_MODE
    process.env.FINNY_HARNESS_MODE = "1"
    try {
      expect(buildWorkflowContinuationReminder({ workflow: failedWorkflow(1), pendingContextTasks: 0 })).toBeUndefined()
    } finally {
      if (prior === undefined) delete process.env.FINNY_HARNESS_MODE
      else process.env.FINNY_HARNESS_MODE = prior
    }
  })

  test("does not skip a user-facing handoff question after a failed trial", () => {
    const assistantText =
      "v12 failed with negative alpha. Would you like me to try a slow EMA crossover next, or pivot to mean reversion?"
    expect(isYieldingControlToUser({ assistantText })).toBeTrue()
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(4),
        pendingContextTasks: 0,
        assistantText,
      }),
    ).toBeUndefined()
  })

  test("does not skip let-me-know handoffs that invite the next user decision", () => {
    const assistantText =
      "The champion candidates are fully validated and ready for deployment. Let me know if you would like to begin paper-trading these models!"
    expect(isYieldingControlToUser({ assistantText })).toBeTrue()
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(6),
        pendingContextTasks: 0,
        assistantText,
      }),
    ).toBeUndefined()
  })

  test("detects question-tool handoffs as user control", () => {
    expect(
      isYieldingControlToUser({
        assistantParts: [{ type: "tool", tool: "question", state: { status: "completed" } }],
      }),
    ).toBeTrue()
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(2),
        pendingContextTasks: 0,
        assistantParts: [{ type: "tool", tool: "question", state: { status: "completed" } }],
      }),
    ).toBeUndefined()
  })

  test("does not treat plain failed-result narration without a user ask as a handoff", () => {
    const assistantText = "v8 failed. I will save a corrected short-only Supertrend and re-run the backtest."
    expect(isYieldingControlToUser({ assistantText })).toBeFalse()
    expect(
      buildWorkflowContinuationReminder({
        workflow: failedWorkflow(3),
        pendingContextTasks: 0,
        assistantText,
      }),
    ).toContain("next response MUST call finny_algorithm_save")
  })
})

describe("parent/context overlap evidence", () => {
  const tool = (name: string, status = "completed") => ({ type: "tool", tool: name, state: { status } })

  test("does not count a preparation action completed before the context batch", () => {
    expect(hasParentOverlapActionAfterContextLaunch([{ parts: [tool("read"), tool("task_batch_run")] }])).toBeFalse()
  })

  test("counts a subsequent completed read or todo projection as useful parent overlap", () => {
    expect(
      hasParentOverlapActionAfterContextLaunch([{ parts: [tool("task_batch_run")] }, { parts: [tool("todowrite")] }]),
    ).toBeTrue()
  })

  test("does not count task, synthesis, save, backtest, or review work", () => {
    expect(
      hasParentOverlapActionAfterContextLaunch([
        { parts: [tool("task_batch_run")] },
        {
          parts: [
            tool("task_await"),
            tool("finny_evidence_synthesize"),
            tool("finny_algorithm_save"),
            tool("finny_backtest"),
            tool("finny_review_packet"),
          ],
        },
      ]),
    ).toBeFalse()
  })

  test("ignores incomplete preparation tools", () => {
    expect(
      hasParentOverlapActionAfterContextLaunch([{ parts: [tool("task_batch_run"), tool("read", "running")] }]),
    ).toBeFalse()
  })
})
