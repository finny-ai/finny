import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  contextPhaseExecutionBlock,
  filterContextPhaseTools,
  requiredContextLaunchSystemFragment,
  requiredContextLaunchBlock,
  requiresConcurrentContextKickoff,
  SAFE_PARENT_OVERLAP_TOOLS,
  unmetRequiredContextRoles,
  unlaunchedRequiredContextRoles,
} from "@/task/strategy-context"
import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"
import { isStrategySynthesisPath } from "@/tool/finny-workspace-guard"

describe("pending strategy-context capability surface", () => {
  const definitions = [
    "question",
    "task_start",
    "task_run",
    "task_batch_run",
    "read",
    "glob",
    "grep",
    "todowrite",
    "finny_get_history",
    "websearch",
    "finny_algorithm_save",
    "finny_backtest",
    "finny_review_packet",
  ].map((id) => ({ id }))

  test("keeps the complete advertised Finny surface visible while context is pending", () => {
    expect(filterContextPhaseTools(definitions, { pendingCount: 2, launchRequired: false })).toBe(definitions)
    expect([...SAFE_PARENT_OVERLAP_TOOLS]).toEqual(["read", "glob", "grep", "todowrite"])
  })

  test("keeps save, backtest, and review definitions visible before the required launch", () => {
    const visible = filterContextPhaseTools(definitions, { pendingCount: 0, launchRequired: true })
    expect(visible).toBe(definitions)
    expect(visible.map((definition) => definition.id)).toEqual(definitions.map((definition) => definition.id))
  })

  test("keeps launch tools available when one required role is pending but another was omitted", () => {
    expect(
      filterContextPhaseTools(definitions, { pendingCount: 1, launchRequired: true }).map(
        (definition) => definition.id,
      ),
    ).toContain("task_batch_run")
  })

  test("preserves the same capability object after every context delivery", () => {
    expect(filterContextPhaseTools(definitions, { pendingCount: 0, launchRequired: false })).toBe(definitions)
  })

  test("the prompt loop passes full registered definitions plus an execution-time gate", () => {
    const promptSource = fs.readFileSync(new URL("../../src/session/prompt.ts", import.meta.url), "utf8")
    const toolsSource = fs.readFileSync(new URL("../../src/session/tools.ts", import.meta.url), "utf8")
    expect(promptSource).toContain("filterContextPhaseTools(capabilityDefinitions")
    expect(promptSource).toContain("strategyContextGate: {")
    expect(toolsSource).toContain("contextPhaseExecutionBlock(item.id, input.strategyContextGate)")
    expect(promptSource).toContain("includeMcpTools: pendingContext.length === 0 && !contextLaunchRequired")
    expect(toolsSource).toContain('input.includeMcpTools === false ? {} : yield* mcp.tools()')
  })
})

const delegatedWorkflow = {
  evidenceRequirements: [
    { id: "market_data:BTC.USD", kind: "market_data", required: true },
    { id: "news:request", kind: "news", required: true },
  ],
  evidence: [],
} as unknown as BuildWorkflowState

describe("required strategy-context roles", () => {
  test("maps unmet WorkflowRun requirements to the exact kickoff roles", () => {
    expect(requiresConcurrentContextKickoff(delegatedWorkflow)).toBe(true)
    expect(unmetRequiredContextRoles(delegatedWorkflow)).toEqual(["data_extractor", "news_agent"])
    expect(
      unlaunchedRequiredContextRoles(delegatedWorkflow, [
        { subagentType: "data_extractor", status: "running" },
      ]),
    ).toEqual(["news_agent"])
  })

  test("does not count a failed launch or unrelated role as required context", () => {
    expect(
      unlaunchedRequiredContextRoles(delegatedWorkflow, [
        { subagentType: "data_extractor", status: "failed" },
        { subagentType: "researcher", status: "running" },
      ]),
    ).toEqual(["data_extractor", "news_agent"])
  })

  test("rejects an initial batch that omits any required role", () => {
    expect(
      requiredContextLaunchBlock({
        workflow: delegatedWorkflow,
        tasks: [],
        requestedRoles: ["data_extractor"],
        batch: true,
      }),
    ).toContain("Missing required roles: data_extractor, news_agent")
    expect(
      requiredContextLaunchBlock({
        workflow: delegatedWorkflow,
        tasks: [],
        requestedRoles: ["data_extractor", "news_agent"],
        batch: true,
      }),
    ).toBeUndefined()
  })

  test("visible scaffold is blocked before launch, while pending, and admitted only after verified context", () => {
    const missing = unlaunchedRequiredContextRoles(delegatedWorkflow, [])
    const launchBlock = contextPhaseExecutionBlock("finny_algorithm_scaffold", {
      unlaunchedRequiredRoles: missing,
      pendingTasks: [],
    })
    expect(launchBlock?.metadata.strategyContext).toBe("launch_required")
    expect(launchBlock?.output).toContain("Call task_batch_run now with every missing role")

    const activeTasks = [
      { id: "task_data", subagentType: "data_extractor", status: "running" },
      { id: "task_news", subagentType: "news_agent", status: "running" },
    ] as const
    const pendingBlock = contextPhaseExecutionBlock("finny_algorithm_scaffold", {
      unlaunchedRequiredRoles: unlaunchedRequiredContextRoles(delegatedWorkflow, activeTasks),
      pendingTasks: activeTasks,
    })
    expect(pendingBlock?.metadata.strategyContext).toBe("pending")
    expect(pendingBlock?.output).toContain("data_extractor:task_data")

    const verifiedWorkflow = {
      ...delegatedWorkflow,
      evidence: delegatedWorkflow.evidenceRequirements.map((requirement) => ({
        requirementId: requirement.id,
        status: "verified",
      })),
    } as BuildWorkflowState
    expect(contextPhaseExecutionBlock("finny_algorithm_scaffold", {
      unlaunchedRequiredRoles: unlaunchedRequiredContextRoles(verifiedWorkflow, []),
      pendingTasks: [],
    })).toBeUndefined()
  })

  test("execution gate blocks unsafe Finny actions without blocking safe overlap tools", () => {
    const gate = {
      unlaunchedRequiredRoles: ["data_extractor", "news_agent"],
      pendingTasks: [],
    }
    for (const tool of [
      "finny_backtest",
      "finny_review_packet",
      "finny_get_history",
      "finny_get_quote",
      "webfetch",
      "websearch",
      "apply_patch",
    ]) {
      expect(contextPhaseExecutionBlock(tool, gate)?.metadata.blocked).toBe(true)
    }
    for (const tool of ["read", "write", "edit", "todowrite", "task_batch_run", "finny_algorithm_save"]) {
      expect(contextPhaseExecutionBlock(tool, gate)).toBeUndefined()
    }
  })

  test("save remains available before kickoff and while context tasks are pending", () => {
    expect(
      contextPhaseExecutionBlock("finny_algorithm_save", {
        unlaunchedRequiredRoles: ["data_extractor", "sec_agent", "sentiment_agent"],
        pendingTasks: [],
      }),
    ).toBeUndefined()
    expect(
      contextPhaseExecutionBlock("finny_algorithm_save", {
        unlaunchedRequiredRoles: [],
        pendingTasks: [{ id: "task_sec", subagentType: "sec_agent" }],
      }),
    ).toBeUndefined()
  })

  test("direct evidence tools stay visible but are blocked until context is verified", () => {
    const tools = ["finny_get_history", "finny_get_quote", "webfetch", "websearch"]
    const beforeLaunch = {
      unlaunchedRequiredRoles: ["data_extractor", "news_agent"],
      pendingTasks: [],
    }
    const whilePending = {
      unlaunchedRequiredRoles: [],
      pendingTasks: [{ id: "task_data", subagentType: "data_extractor" }],
    }
    const verified = { unlaunchedRequiredRoles: [], pendingTasks: [] }

    for (const tool of tools) {
      expect(contextPhaseExecutionBlock(tool, beforeLaunch)?.metadata.strategyContext).toBe("launch_required")
      expect(contextPhaseExecutionBlock(tool, whilePending)?.metadata.strategyContext).toBe("pending")
      expect(contextPhaseExecutionBlock(tool, verified)).toBeUndefined()
    }
  })

  test("pending context admits mission and analysis writes while path guard retains synthesis ownership", () => {
    const pendingGate = {
      unlaunchedRequiredRoles: [],
      pendingTasks: [{ id: "task_news", subagentType: "news_agent" }],
    }
    expect(contextPhaseExecutionBlock("write", pendingGate)).toBeUndefined()
    expect(contextPhaseExecutionBlock("edit", pendingGate)).toBeUndefined()

    const workspace = path.join("/tmp", "finny", "algos", "btc-daily")
    expect(isStrategySynthesisPath(workspace, path.join(workspace, "mission.md"))).toBe(false)
    expect(isStrategySynthesisPath(workspace, path.join(workspace, "analysis", "setup.py"))).toBe(false)
    expect(isStrategySynthesisPath(workspace, path.join(workspace, "edge_analysis.md"))).toBe(true)
    expect(isStrategySynthesisPath(workspace, path.join(workspace, "v01", "strategy.py"))).toBe(true)
  })

  test("verified evidence removes only its own required role", () => {
    const workflow = {
      ...delegatedWorkflow,
      evidence: [
        {
          requirementId: "market_data:BTC.USD",
          status: "verified",
        },
      ],
    } as unknown as BuildWorkflowState
    expect(unmetRequiredContextRoles(workflow)).toEqual(["news_agent"])
  })

  test("tells the parent to relaunch terminal roles whose evidence was not verified", () => {
    expect(requiredContextLaunchSystemFragment(["news_agent"])).toContain(
      "A readable artifact or completed child task does not satisfy this gate",
    )
    expect(requiredContextLaunchSystemFragment(["news_agent"])).toContain("Call task_run or task_start now for news_agent")
    expect(requiredContextLaunchSystemFragment(["data_extractor", "news_agent"])).toContain(
      "Call task_batch_run once with every missing role",
    )
  })
})
