import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { algoDir, bindSessionWorkspace, ensureAlgoWorkspace } from "@finny-ai/core/algo"
import { Effect, Exit } from "effect"
import { createFinnyHarnessHooks, renderWorkflowCompactionContext } from "@/plugin/finny-harness"
import { createBuildWorkflow, makeApprovalChallenge } from "@/algorithm/build-workflow/state"
import { clearAllWorkflowHookSnapshots, publishWorkflowHookSnapshot } from "@/algorithm/build-workflow/hook-snapshot"
import { evaluateFinnyWorkspacePathPolicy, FinnyWorkspacePolicyError } from "@/tool/finny-workspace-guard"
import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"
import { runToolHookLifecycle } from "@/session/tool-hook-lifecycle"

let sandbox: string
let previousXdg: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-harness-"))
  previousXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = sandbox
  clearAllWorkflowHookSnapshots()
})

afterEach(async () => {
  clearAllWorkflowHookSnapshots()
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousXdg
  await fs.rm(sandbox, { recursive: true, force: true })
})

function setup() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const hooks = createFinnyHarnessHooks(
    {
      directory: sandbox,
      worktree: sandbox,
    } as any,
    provider.getTracer("test"),
  )
  return { exporter, hooks }
}

function context(sessionID: string, callID: string, tool = "read") {
  return {
    tool,
    sessionID,
    callID,
    messageID: `msg_${sessionID}`,
    parentSessionID: `parent_${sessionID}`,
    agent: "finny",
  }
}

describe("FinnyHarnessPlugin spans", () => {
  test("isolates reused call IDs across sessions and closes terminal outcomes", async () => {
    const { exporter, hooks } = setup()
    const first = context("ses_one", "call_shared", "question")
    const second = context("ses_two", "call_shared", "question")

    await hooks["tool.execute.before"]!(first, { args: { question: "one" } })
    await hooks["tool.execute.before"]!(second, { args: { question: "two" } })
    await hooks["tool.execute.after"]!({ ...first, args: {} }, { title: "", output: "ok", metadata: {} })
    await hooks["tool.execute.error"]!(
      { ...second, args: {} },
      { error: new Error("cancelled by caller"), phase: "execute", interrupted: true },
    )

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(2)
    expect(spans.find((span) => span.attributes["session.id"] === "ses_one")?.attributes).toMatchObject({
      "finny.harness.outcome": "completed",
      "tool.call_id": "call_shared",
    })
    expect(spans.find((span) => span.attributes["session.id"] === "ses_two")?.attributes).toMatchObject({
      "finny.harness.outcome": "cancelled",
      "tool.call_id": "call_shared",
    })
  })

  test("exports hashes and sizes without raw payloads, paths, secrets, custom names, or errors", async () => {
    const { exporter, hooks } = setup()
    const event = context("ses_private", "call_private", "private_server_secret_tool")
    const args = { filePath: "/Users/alice/private/strategy.ts", apiKey: "sk-secret", prompt: "raw prompt" }
    await hooks["tool.execute.before"]!(event, { args })
    await hooks["tool.execute.error"]!(
      { ...event, args },
      { error: new Error("broker password leaked at /Users/alice/private"), phase: "execute", interrupted: false },
    )

    const span = exporter.getFinishedSpans()[0]
    const exported = JSON.stringify(span.attributes)
    expect(span.name).toBe("finny.harness.tool")
    expect(span.attributes["tool.kind"]).toBe("custom_or_mcp")
    expect(span.attributes["tool.name_hash"]).toMatch(/^[a-f0-9]{32}$/)
    expect(span.attributes["tool.input.sha256"]).toMatch(/^[a-f0-9]{64}$/)
    expect(span.attributes["error.message.sha256"]).toMatch(/^[a-f0-9]{64}$/)
    expect(exported).not.toContain("private_server_secret_tool")
    expect(exported).not.toContain("/Users/alice")
    expect(exported).not.toContain("sk-secret")
    expect(exported).not.toContain("raw prompt")
    expect(exported).not.toContain("broker password")
  })

  test("classifies successful workflow blockers and cancels outstanding spans on disposal", async () => {
    const { exporter, hooks } = setup()
    const blocked = context("ses_blocked", "call_blocked", "finny_backtest")
    const pending = context("ses_pending", "call_pending", "bash")
    await hooks["tool.execute.before"]!(blocked, { args: {} })
    await hooks["tool.execute.after"]!(
      { ...blocked, args: {} },
      { title: "", output: "", metadata: { blockerCode: "evidence_missing", artifactIds: ["artifact_1"] } },
    )
    await hooks["tool.execute.before"]!(pending, { args: {} })
    await hooks.dispose!()

    expect(
      exporter
        .getFinishedSpans()
        .map((span) => span.attributes["finny.harness.outcome"])
        .sort(),
    ).toEqual(["blocked", "cancelled"])
  })

  test("an after-hook failure closes the harness span as failed", async () => {
    const { exporter, hooks } = setup()
    const event = context("ses_after_failure", "call_after_failure", "question")
    const plugin = {
      trigger(name: keyof typeof hooks, hookInput: any, output: any) {
        return Effect.promise(async () => {
          if (name === "tool.execute.after") throw new Error("later after hook failed")
          const harness = hooks[name] as ((input: any, value: any) => Promise<void>) | undefined
          await harness?.(hookInput, output)
          return output
        })
      },
    } as any
    const exit = await Effect.runPromiseExit(
      runToolHookLifecycle({
        plugin,
        context: event,
        args: {},
        execute: () => Effect.succeed({ title: "", output: "ok", metadata: {} }),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      "finny.harness.outcome": "failed",
      "tool.error_phase": "after",
    })
  })
})

describe("workflow continuity", () => {
  test("renders bounded authoritative state with pending evidence, approval, blocker, and resume token", async () => {
    const challenge = makeApprovalChallenge({
      id: "approval_provider",
      kind: "provider_change",
      scope: { from: "one", to: "two" },
      reason: "provider coverage",
      now: 10,
    })
    const base = createBuildWorkflow({
      workflowId: "wf_compact",
      sessionId: "ses_compact",
      workspaceSlug: "workspace-not-exported",
      intent: "build",
      newsRequired: true,
      identity: { symbols: { value: ["SPY"], source: { kind: "user_message", messageId: "msg_1" } } },
      now: 1,
    })
    const state: BuildWorkflowState = {
      ...base,
      status: "blocked",
      approvalChallenges: [challenge],
      blocker: { code: "evidence_missing", message: "/Users/alice/private", eventId: "evt_block" },
    }
    const snapshot = publishWorkflowHookSnapshot(state)
    const rendered = renderWorkflowCompactionContext(snapshot)
    expect(rendered.length).toBeLessThanOrEqual(2_000)
    expect(rendered).toContain("phase: identity_confirmed")
    expect(rendered).toContain("market_data:SPY:market_data")
    expect(rendered).toContain("news:request:news")
    expect(rendered).toContain("approval_provider:provider_change")
    expect(rendered).toContain("blocker: evidence_missing")
    expect(rendered).toContain(`resume_token: ${state.resumeToken}`)
    expect(rendered).not.toContain("/Users/alice")
    expect(rendered).not.toContain("workspace-not-exported")

    const { hooks } = setup()
    publishWorkflowHookSnapshot(state)
    const output = { context: [] as string[], prompt: "keep existing prompt" }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_compact" }, output)
    expect(output.context).toEqual([rendered])
    expect(output.prompt).toBe("keep existing prompt")
  })

  test("skips mismatched or missing session snapshots", async () => {
    const state = createBuildWorkflow({
      workflowId: "wf_other",
      sessionId: "ses_other",
      workspaceSlug: "other",
      intent: "research",
      identity: {},
    })
    publishWorkflowHookSnapshot(state)
    const { hooks } = setup()
    publishWorkflowHookSnapshot(state)
    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_missing" }, output)
    expect(output.context).toEqual([])
  })

  test("uses only matching controller-owned request.json basics as a fallback", async () => {
    const workspace = await ensureAlgoWorkspace("compaction-fallback")
    await bindSessionWorkspace("ses_fallback", workspace.slug)
    await fs.writeFile(
      path.join(algoDir(workspace.slug), "request.json"),
      JSON.stringify({
        source_of_truth: "algorithm_build_workflow",
        request_id: "ses_fallback",
        workflow_id: "wf_fallback",
        workflow_revision: 7,
        workflow_stage: "evidence_ready",
        workflow_phase: "research_frozen",
        request_version: 2,
        resume_token: "wfr_fallback",
      }),
    )
    const { hooks } = setup()
    const valid = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_fallback" }, valid)
    expect(valid.context.join("\n")).toContain("workflow_id: wf_fallback")
    expect(valid.context.join("\n")).toContain("pending_evidence: none")

    await fs.writeFile(
      path.join(algoDir(workspace.slug), "request.json"),
      JSON.stringify({
        source_of_truth: "algorithm_build_workflow",
        request_id: "ses_other",
        workflow_id: "/Users/alice/private",
        workflow_revision: 7,
        workflow_stage: "made_up",
        workflow_phase: "research_frozen",
        request_version: 2,
        resume_token: "wfr_fallback",
      }),
    )
    const malformed = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_fallback" }, malformed)
    expect(malformed.context).toEqual([])
  })
})

describe("shared workspace policy", () => {
  test("the harness before-hook returns the same fail-closed policy decision without mutating arguments", async () => {
    const workspace = await ensureAlgoWorkspace("policy-parity")
    await bindSessionWorkspace("ses_policy", workspace.slug)
    const raw = { filePath: path.join(sandbox, "outside.md"), content: "unchanged" }
    const direct = await evaluateFinnyWorkspacePathPolicy({
      agent: "news_agent",
      sessionID: "ses_policy",
      filePath: raw.filePath,
      operation: "write",
      directory: sandbox,
      worktree: sandbox,
    })
    expect(direct).toMatchObject({ allowed: false, code: "news_path_blocked" })

    const { hooks } = setup()
    const before = structuredClone(raw)
    const failure = await hooks["tool.execute.before"]!(
      { ...context("ses_policy", "call_policy", "write"), agent: "news_agent" },
      { args: raw },
    ).catch((error) => error)
    expect(failure).toBeInstanceOf(FinnyWorkspacePolicyError)
    expect(failure.code).toBe((direct as Extract<typeof direct, { allowed: false }>).code)
    expect(raw).toEqual(before)
  })
})
