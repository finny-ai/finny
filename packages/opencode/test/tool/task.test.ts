import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import {
  completedIntradayWindow,
  evidenceDelegationBlock,
  EMPTY_SUBAGENT_RESULT_MARKER,
  finalSpecialistTaskText,
  finalTaskText,
  dataExtractorRepairInstruction,
  inferBatchSubagentType,
  resolveBatchSubagentType,
  shouldBackgroundRecommendedEvidence,
  taskRegistryErrorText,
  TaskBatchRunTool,
  TaskRunTool,
  TaskStartTool,
  TaskTool,
  type TaskPromptOps,
} from "../../src/tool/task"
import { resolveWorkspacePrepareWindow, WorkspacePrepareTool } from "../../src/tool/workspace-prepare"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TaskState } from "@/task/state"
import { StrategyContext } from "@/task/strategy-context"
import { AlgorithmScaffoldTool } from "@/tool/algorithm-scaffold"
import { StrategyContextWaitTool } from "@/tool/strategy-context-wait"
import { assertFinnyWorkspacePathPolicy, isStrategySynthesisPath } from "@/tool/finny-workspace-guard"
import { BuildWorkflow } from "@/task/build-workflow"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { authoritativeWorkflowTodos } from "@/tool/todo"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import {
  algoDir,
  bindSessionWorkspace,
  clearSessionWorkspace,
  getSessionWorkspace,
  parseMission,
} from "@finny-ai/core/algo"
import { syncWorkspaceRequestContext } from "../../src/agent/finny-workspace-context"
import { finalizeDatasetEvidenceFile } from "../../src/data/dataset-evidence-finalizer"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

describe("evidence-optional exploratory delegation", () => {
  const workflow = {
    requestVersion: 1,
    phase: "identity_confirmed" as const,
    evidence: [],
    researchFreeze: undefined,
    candidate: undefined,
    experimentPlan: undefined,
    attempts: [],
  }

  test("skips evidence agents for an ordinary backtest-only request", () => {
    const dataExtractorResult = evidenceDelegationBlock({
      subagentType: "data_extractor",
      latestUserText: "Backtest the existing XRP daily strategy",
      workflow,
    })
    expect(dataExtractorResult).toContain("SKIPPED:")
    expect(dataExtractorResult).not.toContain("Run finny_backtest directly")
    expect(
      evidenceDelegationBlock({
        subagentType: "news_agent",
        latestUserText: "Rerun the XRP daily backtest",
        workflow,
      }),
    ).toContain("SKIPPED:")
  })

  test("allows new builds, explicit evidence requests, and non-evidence agents", () => {
    for (const subagentType of ["data_extractor", "news_agent", "sentiment_agent"]) {
      expect(
        evidenceDelegationBlock({
          subagentType,
          latestUserText: "Create and backtest a new SPY 5m strategy",
          workflow,
        }),
      ).toBeUndefined()
    }
    expect(
      evidenceDelegationBlock({
        subagentType: "data_extractor",
        latestUserText: "Extract XRP daily market data",
        workflow,
      }),
    ).toBeUndefined()
    expect(evidenceDelegationBlock({ subagentType: "general", latestUserText: "XRP daily", workflow })).toBeUndefined()
  })

  test("allows evidence after an accepted exploratory backtest", () => {
    expect(
      evidenceDelegationBlock({
        subagentType: "news_agent",
        latestUserText: "XRP daily",
        workflow: {
          ...workflow,
          attempts: [
            {
              id: "attempt_research",
              idempotencyKey: "finish",
              fingerprint: "research",
              operation: "finny_backtest:finish",
              outcome: "accepted",
              lifecycle: "terminal",
              requiredChanges: [],
              requestVersion: 1,
              artifactIds: [],
              evidenceIds: [],
              trialIds: [],
              createdAt: 2,
            },
          ],
        },
      }),
    ).toBeUndefined()
  })

  test("keeps recommended new-build evidence in the background", () => {
    for (const subagentType of ["data_extractor", "news_agent", "sentiment_agent"]) {
      expect(
        shouldBackgroundRecommendedEvidence({
          agent: "finny",
          subagentType,
          latestUserText: "Create a new SPY 5m strategy",
          workflow,
        }),
      ).toBe(true)
    }
    expect(
      shouldBackgroundRecommendedEvidence({
        agent: "finny",
        subagentType: "data_extractor",
        latestUserText: "Backtest the existing SPY 5m strategy",
        workflow,
      }),
    ).toBe(false)
  })
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.suspend(() =>
    Layer.mergeAll(
      Agent.defaultLayer,
      BackgroundJob.defaultLayer,
      EventV2Bridge.defaultLayer,
      Config.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      Session.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      Truncate.defaultLayer,
      ToolRegistry.defaultLayer,
      BuildWorkflow.defaultLayer,
      Database.defaultLayer,
      RuntimeFlags.layer(flags),
    ).pipe(Layer.provide(Ripgrep.defaultLayer)),
  )

const it = testEffect(layer())
const background = testEffect(layer())

it.instance("finalizes a task when its synthetic completion is admitted to the parent", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { chat } = yield* seed()
    const sessions = yield* Session.Service
    const child = yield* sessions.create({ parentID: chat.id, title: "sentiment context" })
    const taskID = child.id
    yield* Effect.promise(() =>
      TaskState.upsert(
        {
          id: taskID,
          parentSessionID: chat.id,
          description: "sentiment context",
          subagentType: "sentiment_agent",
          mode: "background",
          status: TaskState.Status.running,
        },
        database,
      ),
    )

    yield* Effect.promise(() =>
      StrategyContext.finalizeDeliveredTasks(chat.id, database, [
        {
          parts: [
            {
              type: "text",
              synthetic: true,
              text: `<task id="${taskID}" state="completed">\n<task_result>sentiment context ready</task_result>\n</task>`,
            },
          ],
        },
      ]),
    )

    expect(yield* Effect.promise(() => TaskState.get(taskID, database))).toMatchObject({
      status: TaskState.Status.completed,
      resultSummary: "sentiment context ready",
    })
  }),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned", userText?: string) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  if (userText) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: user.id,
      type: "text",
      text: userText,
    })
  }
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, user, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string | ((input: SessionPrompt.PromptInput) => string)
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        const text = typeof opts?.text === "function" ? opts.text(input) : (opts?.text ?? "done")
        return reply(input, text)
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

async function seedPartialBtcEvidence(input: { sessionID: string; slug: string }) {
  await bindSessionWorkspace(input.sessionID, input.slug)
  const context = await syncWorkspaceRequestContext({
    sessionID: input.sessionID,
    slug: input.slug,
    prompt: "Research BTC crypto with 1d bars from 2026-07-01 to 2026-07-10.",
  })
  const dataRoot = path.join(algoDir(input.slug), "data")
  const csvPath = "crypto/BTC_1d_2026-07-01_2026-07-10.csv"
  await fs.mkdir(path.join(dataRoot, "crypto"), { recursive: true })
  await fs.writeFile(
    path.join(dataRoot, csvPath),
    [
      "timestamp,open,high,low,close,volume",
      "2026-07-01T00:00:00Z,100,101,99,100.5,1000",
      "2026-07-02T00:00:00Z,100.5,102,100,101.5,1200",
    ].join("\n"),
  )
  return finalizeDatasetEvidenceFile({
    dataRoot,
    csvPath,
    request: context,
    workspaceSlug: input.slug,
    canonicalSymbol: "BTC",
    provider: { id: "binance", feed: "public-klines", venue: "BINANCE", providerSymbol: "BTCUSDT" },
    priceBasis: {
      basis: "raw",
      split_treatment: "not_applicable",
      dividend_treatment: "not_applicable",
      corporate_action_status: "not_applicable",
      events: [],
    },
    analysisSummaryPath: "crypto/BTC_1d_2026-07-01_2026-07-10.analysis_summary.json",
    analysisRegime: "range_bound",
    analysisHypotheses: ["Candidate mean reversion; requires backtest."],
    now: new Date("2026-07-11T12:00:00Z"),
  })
}

describe("finalTaskText", () => {
  const part = (type: string, text?: string) => ({ type, text })

  test("returns the last text part trimmed", () => {
    expect(finalTaskText([part("text", "first"), part("tool"), part("text", "  done  ")])).toBe("done")
  })

  test("substitutes the BLOCKED marker when there is no text part", () => {
    expect(finalTaskText([part("tool")])).toBe(EMPTY_SUBAGENT_RESULT_MARKER)
    expect(finalTaskText([])).toBe(EMPTY_SUBAGENT_RESULT_MARKER)
  })

  test("substitutes the BLOCKED marker for empty text", () => {
    expect(finalTaskText([part("text", "   ")])).toBe(EMPTY_SUBAGENT_RESULT_MARKER)
    expect(finalTaskText([part("text", "")])).toBe(EMPTY_SUBAGENT_RESULT_MARKER)
  })

  test("marker routes into existing BLOCKED handling", () => {
    expect(EMPTY_SUBAGENT_RESULT_MARKER.startsWith("BLOCKED:")).toBe(true)
  })

  test("durable specialist artifacts recover an empty final chat part", () => {
    const pointer = '<subagent-artifact agent="sec_agent">\n- file: data/sec/TD/sec_manifest.json\n</subagent-artifact>'
    const text = finalSpecialistTaskText({
      subagentType: "sec_agent",
      text: EMPTY_SUBAGENT_RESULT_MARKER,
      pointer,
    })
    expect(text).toContain("completed with durable request-scoped artifacts")
    expect(text).toContain(pointer)
    expect(text).not.toStartWith("BLOCKED:")
    expect(
      finalSpecialistTaskText({
        subagentType: "sec_agent",
        text: EMPTY_SUBAGENT_RESULT_MARKER,
        pointer: "",
      }),
    ).toBe(EMPTY_SUBAGENT_RESULT_MARKER)
  })
})

test("data repair instruction targets only exact missing ranges and the existing canonical dataset", () => {
  const text = dataExtractorRepairInstruction({
    requestedSymbol: "SPY",
    requestedInterval: "1h",
    requestedStart: "2025-08-01",
    requestedEnd: "2026-07-31",
    rows: 2_183,
    expectedCount: 3_934,
    actualCount: 2_183,
    missingCount: 2,
    extraCount: 0,
    missingRanges: [{ start: "2026-07-30T14:30:00Z", end: "2026-07-30T15:30:00Z", count: 2 }],
    csvPath: "stock/SPY_1h.csv",
    manifestPath: "stock/SPY_1h.manifest.json",
    source: "alpaca/iex/IEX",
    coverage: "partial",
  })
  expect(text).toContain('"start":"2026-07-30T14:30:00Z"')
  expect(text).toContain("Canonical CSV: stock/SPY_1h.csv")
  expect(text).toContain("Fetch only those missing ranges")
  expect(text).toContain("Do not redownload the full window")
  expect(text).toContain("coverage, regime, and candidate-hypothesis artifacts")
})

describe("completedIntradayWindow", () => {
  test("caps rolling intraday windows ending on the current UTC date", () => {
    expect(
      completedIntradayWindow({
        start: "2025-06-16",
        end: "2026-06-16",
        interval: "1h",
        now: new Date("2026-06-16T15:49:08Z"),
      }),
    ).toEqual({ start: "2025-06-16", end: "2026-06-15", adjusted: true })
  })

  test("leaves explicit completed or daily windows unchanged", () => {
    const now = new Date("2026-06-16T15:49:08Z")
    expect(completedIntradayWindow({ start: "2025-06-15", end: "2026-06-15", interval: "1h", now })).toEqual({
      start: "2025-06-15",
      end: "2026-06-15",
      adjusted: false,
    })
    expect(completedIntradayWindow({ start: "2025-06-16", end: "2026-06-16", interval: "1d", now })).toEqual({
      start: "2025-06-16",
      end: "2026-06-16",
      adjusted: false,
    })
  })
})

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const dataExtractor = first.indexOf("- data_extractor:")
        const newsAgent = first.indexOf("- news_agent:")

        expect(dataExtractor).toBeGreaterThan(-1)
        expect(newsAgent).toBeGreaterThan(dataExtractor)
        expect(first).not.toContain("- alpha: Alpha agent")
        expect(first).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("enforces the Fund Manager delegation boundary before launch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      let asks = 0
      let seen: SessionPrompt.PromptInput | undefined
      const context = (agent: string) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        agent,
        abort: new AbortController().signal,
        extra: {
          promptOps: stubOps({
            text: "advisory complete",
            onPrompt: (input) => (seen = input),
          }),
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () =>
          Effect.sync(() => {
            asks += 1
          }),
      })
      const task = {
        description: "Review regime",
        prompt: "Review the supplied immutable regime evidence.",
        subagent_type: "fund_regime_analyst",
      }

      const nonManager = yield* Effect.exit(def.execute(task, context("finny")))
      expect(Exit.isFailure(nonManager)).toBe(true)
      if (Exit.isFailure(nonManager)) {
        expect(String(Cause.squash(nonManager.cause))).toContain('may be launched only by "fund_manager"')
      }
      expect(asks).toBe(0)

      const nested = yield* Effect.exit(
        def.execute({ ...task, subagent_type: "fund_risk_sentinel" }, context("fund_regime_analyst")),
      )
      expect(Exit.isFailure(nested)).toBe(true)
      if (Exit.isFailure(nested)) {
        expect(String(Cause.squash(nested.cause))).toContain("cannot delegate nested tasks")
      }
      expect(asks).toBe(0)

      const result = yield* def.execute(task, context("fund_manager"))
      expect(asks).toBe(0)
      expect(result.output).toContain("No immutable fund event is admitted")
      expect(seen).toBeUndefined()
    }),
  )

  it.instance("records foreground subagent lifecycle in TaskState", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "Research QQQ news",
          prompt: "Research QQQ 15m execution context.",
          subagent_type: "news_agent",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "news complete" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const database = yield* Database.Service
      const tasks = yield* Effect.promise(() => TaskState.listByParent(chat.id, database))
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toEqual(
        expect.objectContaining({
          id: result.metadata.sessionId,
          parentSessionID: chat.id,
          description: "Research QQQ news",
          subagentType: "news_agent",
          mode: "foreground",
          status: TaskState.Status.completed,
          resultSummary: expect.stringContaining("NO_SOURCED_CONTEXT"),
        }),
      )
      expect(tasks[0]?.startedAt).toBeNumber()
      expect(tasks[0]?.finishedAt).toBeNumber()
    }),
  )

  test("taskRegistryErrorText gives a retry-safe blocker instead of a raw sqlite error", () => {
    const text = taskRegistryErrorText(new Error("FOREIGN KEY constraint failed"))
    expect(text).toContain("BLOCKED: internal task registry error")
    expect(text).toContain("Finny could not record its task lifecycle")
    expect(text).toContain("Do not retry this task until the registry is healthy")
    expect(text).toContain("FOREIGN KEY constraint failed")
  })

  it.instance("rejects cross-mode and one-item batch inputs before launching a subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      let launched = false
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ onPrompt: () => (launched = true) }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const run = yield* TaskRunTool
      const runDef = yield* run.init()
      const batch = yield* TaskBatchRunTool
      const batchDef = yield* batch.init()

      const crossMode = yield* Effect.exit(
        runDef.execute(
          {
            description: "Inspect data",
            prompt: "Inspect the data",
            subagent_type: "data_extractor",
            tasks: [],
          } as never,
          context,
        ),
      )
      const oneItemBatch = yield* Effect.exit(
        batchDef.execute(
          {
            tasks: [{ description: "Inspect data", prompt: "Inspect the data", subagent_type: "data_extractor" }],
          } as never,
          context,
        ),
      )

      expect(Exit.isFailure(crossMode)).toBe(true)
      expect(Exit.isFailure(oneItemBatch)).toBe(true)
      expect(launched).toBe(false)
    }),
  )

  test("infers an omitted batch subagent_type from the entry description and prompt", () => {
    expect(
      resolveBatchSubagentType({
        description: "OHLCV coverage + regime",
        prompt: "You are the data_extractor for a Finny strategy-research workspace.",
      }),
    ).toBe("data_extractor")
    expect(
      resolveBatchSubagentType({
        description: "News + catalysts brief",
        prompt: "You are the news_agent. Gather cited news and market-context evidence.",
      }),
    ).toBe("news_agent")
    expect(
      resolveBatchSubagentType({
        description: "SEC filings for equities",
        prompt: "You are the sec_agent. Gather SEC EDGAR public-records evidence.",
      }),
    ).toBe("sec_agent")
    expect(
      resolveBatchSubagentType({
        description: "Aggregate sentiment brief",
        prompt: "You are the sentiment_agent. Gather aggregate crowd-positioning evidence.",
      }),
    ).toBe("sentiment_agent")
    expect(
      resolveBatchSubagentType({
        description: "Independent researcher pass",
        prompt: "Act as the researcher and summarize the evidence.",
      }),
    ).toBe("researcher")
  })

  test("fails with an actionable message when the batch subagent_type is ambiguous or missing", () => {
    expect(() =>
      resolveBatchSubagentType({ description: "Mixed brief", prompt: "Cover the news and sentiment together" }),
    ).toThrow(/subagent_type/)
    expect(() =>
      resolveBatchSubagentType({ description: "Generic task", prompt: "Do the thing without naming a role" }),
    ).toThrow(/subagent_type/)
    expect(() =>
      resolveBatchSubagentType({
        description: "Generic task",
        prompt: "Do the thing",
        subagent_type: "coder",
      }),
    ).toThrow(/Unknown subagent_type/)
  })

  test("infers batch types only on an unambiguous single hint", () => {
    expect(inferBatchSubagentType({ description: "News", prompt: "sentiment also" })).toBeUndefined()
    expect(
      inferBatchSubagentType({ description: "Coverage task", prompt: "gather filings and crowd sentiment" }),
    ).toBeUndefined()
  })

  it.live("injects complete authoritative runtime context for data_extractor", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-strategy.1.1.00.00"
          const dataDir = path.join(algoDir(slug), "data")
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })
          const dataPrompt = [
            "Acquire SPY OHLCV for an intraday strategy study.",
            "Data request:",
            "- symbol: SPY",
            "- start_date: 2026-03-10",
            "- end_date: 2026-06-10",
            "- end_date_inclusive: true",
            "- provider: auto",
            `- workspace: ${dataDir}`,
            "- asset_class: equity",
            "- interval: 5m",
          ].join("\n")

          yield* def.execute(
            {
              description: "SPY data extraction",
              prompt: dataPrompt,
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text.match(/<data-request>/g)).toHaveLength(1)
          expect(text.match(/<\/data-request>/g)).toHaveLength(1)
          expect(text).toMatch(/- request_id: ses_[A-Za-z0-9]+/)
          expect(text).toContain("- algorithm: spy-5m-strategy")
          expect(text).toContain(`- workspace: ${slug}`)
          expect(text).toContain("- symbols: SPY")
          expect(text).toContain("- asset_class: equity")
          expect(text).toContain("- interval: 5m")
          expect(text).toContain("- start_inclusive: 2026-03-10")
          expect(text).toContain("- end_inclusive: 2026-06-10")
          expect(text).toContain("- provider: auto")
          expect(text).toContain(`- output_dir: ${dataDir}`)
          expect(text).toContain("</data-request>\n\nAcquire SPY OHLCV for an intraday strategy study.")
          expect(text).not.toContain("requested_symbol")
          expect(text).not.toContain("request_content_hash")
          expect(text).not.toContain("allowed_data_dir")
          expect(text).not.toContain("cookbook_path")
          expect(text).not.toContain("mission_path")
          expect(text).not.toContain("provider_capabilities")
          expect(text).not.toContain("MISSING")

          const missionRaw = yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "mission.md"), "utf8"))
          const mission = parseMission(missionRaw)
          expect(mission.frontmatter.scope.universe).toEqual(["SPY"])
          expect(mission.frontmatter.scope.asset_class).toBe("equities")
          expect(mission.frontmatter.scope.horizon).toBe("intraday")
          expect(missionRaw).toContain("requested_start: 2026-03-10")
          expect(missionRaw).toContain("requested_end: 2026-06-10")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("continues partial coverage in the same child and reuses the exhausted partial handoff", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "btc-partial-repair.1.1.00.00"
          const partial = yield* Effect.promise(() => seedPartialBtcEvidence({ sessionID: chat.id, slug }))
          const prompts: SessionPrompt.PromptInput[] = []
          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          const params = {
            description: "BTC partial data repair",
            prompt: "Extract BTC crypto 1d bars from 2026-07-01 to 2026-07-10.",
            subagent_type: "data_extractor",
          }
          const context = {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                onPrompt: (input) => prompts.push(input),
                text: partial.digest,
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }

          const first = yield* def.execute(params, context)
          expect(prompts).toHaveLength(2)
          expect(prompts[0]!.sessionID).toBe(prompts[1]!.sessionID)
          const repairText = prompts[1]!.parts.find((part) => part.type === "text")?.text ?? ""
          expect(repairText).toContain("Fetch only those missing ranges")
          expect(repairText).toContain('"start":"2026-07-03T00:00:00Z"')
          expect(repairText).toContain("Do not redownload the full window or create another canonical dataset")
          expect(first.output).toContain("PARTIAL_DATASET:")
          expect(first.output).toContain("usable_for_research: yes")
          expect(first.output).toContain("analysis_regime: range_bound")
          expect(first.output).toContain("Candidate mean reversion; requires backtest.")
          expect(first.output).toContain("Crucible/backtest collection is independent")
          expect(first.output).not.toContain("BLOCKED:")

          const second = yield* def.execute(params, context)
          expect(prompts).toHaveLength(2)
          expect(second.output).toContain("Bounded repair already completed")
          expect(second.output).toContain("PARTIAL_DATASET:")
          expect(second.metadata.sessionId).toBe(prompts[0]!.sessionID)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("launches the original BTC OHLCV prompt without treating OHLCV as an equity symbol", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "btc-daily-momentum.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Build a BTC crypto momentum strategy with daily bars over the last 2 years.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const result = yield* def.execute(
            {
              description: "BTC daily data extraction",
              prompt: "Extract historical OHLCV data for BTC covering the last 2 years with a 1d interval.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("data request context mismatch")
          expect(seen).toBeDefined()
          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: BTC")
          expect(text).toContain("- interval: 1d")
          expect(text).toContain("- asset_class: crypto")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("rebinds stale parent workspace when data_extractor prompt carries a new stock universe", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, "es-1d-momentum.1.1.00.00"))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "Trump basket data extraction",
              prompt: "Extract daily OHLCV data for stock universe DJT,RUM,GEO,CXW from 2026-01-01 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const parentWorkspace = yield* Effect.promise(() => getSessionWorkspace(chat.id))
          let childWorkspace: string | null | undefined
          const childSessionID = seen?.sessionID
          if (childSessionID) {
            childWorkspace = yield* Effect.promise(() => getSessionWorkspace(childSessionID))
          }
          expect(parentWorkspace).toContain("djt-rum-geo-cxw-1d-strategy")
          expect(childWorkspace).toBe(parentWorkspace)

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: DJT, RUM, GEO, CXW")
          expect(text).not.toContain("- symbols: ES")
          expect(text).toContain("- interval: 1d")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("blocks a hallucinated child ticker outside the parent portfolio universe", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "djt-rum-geo-cxw-1d-swing.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt:
                "requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities from 2026-01-01 to 2026-06-29",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "Bad ES data extraction",
              prompt: "Extract daily OHLCV data for ES from 2026-01-01 to 2026-06-29.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(prompted).toBe(false)
          expect(result.output).toContain("BLOCKED: context mismatch")
          expect(result.output).toContain("requested DJT,RUM,GEO,CXW 1d equity")
          expect(result.output).toContain("references ES 1d equity")
          const entries = yield* Effect.promise(() => fs.readdir(path.dirname(algoDir(slug))))
          expect(entries.some((entry) => entry.startsWith("es-1d"))).toBe(false)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("allows an in-universe child ticker to use the parent portfolio workspace", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "djt-rum-geo-cxw-1d-swing.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt:
                "requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities from 2026-01-01 to 2026-06-29",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          const result = yield* def.execute(
            {
              description: "RUM data extraction",
              prompt:
                "Extract daily OHLCV data for RUM from 2026-01-01 to 2026-06-29. requested_symbol: RUM, requested_interval: 1d, requested_asset_class: equities.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("BLOCKED: context mismatch")
          const seenInput = seen
          expect(seenInput).toBeDefined()
          if (!seenInput) throw new Error("expected RUM child prompt to launch")
          const childWorkspace = yield* Effect.promise(() => getSessionWorkspace(seenInput.sessionID))
          expect(childWorkspace).toBe(slug)
          const text = seenInput.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: RUM")
          expect(text).toContain("- start_inclusive: 2026-01-01")
          expect(text).toContain("- end_inclusive: 2026-06-29")
          expect(text).not.toContain("- symbols: ES")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("preserves parent backtest window when a child extractor prompt widens dates", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "djt-rum-geo-cxw-1d-swing.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt:
                "requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities from 2026-01-01 to 2026-06-29",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "DJT widened data extraction",
              prompt: "Extract daily OHLCV data for DJT from 2025-07-01 to 2026-06-29.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: DJT")
          expect(text).toContain("- start_inclusive: 2026-01-01")
          expect(text).toContain("- end_inclusive: 2026-06-29")

          const request = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")),
          )
          expect(request.requested_symbols).toEqual(["DJT", "RUM", "GEO", "CXW"])
          expect(request.requested_start).toBe("2026-01-01")
          expect(request.requested_end).toBe("2026-06-29")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("blocks a one-year data task before launch when authoritative dates are missing", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "eth-1d-custom.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Research ETH.USD 1d custom strategy for crypto.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "ETH one-year data extraction",
              prompt: "Fetch ETH.USD daily OHLCV from 2025-07-16 to 2026-07-16.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(prompted).toBe(false)
          expect(result.output).toContain("BLOCKED: incomplete authoritative data window")
          expect(result.output).toContain("The invalid task was not registered")

          const request = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")),
          )
          expect(request.requested_symbol).toBe("ETH")
          expect(request.requested_interval).toBe("1d")
          expect(request.requested_start).toBeUndefined()
          expect(request.requested_end).toBeUndefined()
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("allows approved extended data windows after workspace prepare persists dates", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "btc-4h-trend-following.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Research BTC 4h trend following for crypto.",
            }),
          )

          const taskTool = yield* TaskRunTool
          const taskDef = yield* taskTool.init()

          const blocked = yield* taskDef.execute(
            {
              description: "BTC data extraction",
              prompt: "Fetch BTC 4h OHLCV from 2025-06-30 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(blocked.output).toContain("BLOCKED: incomplete authoritative data window")

          const workspaceTool = yield* WorkspacePrepareTool
          const workspaceDef = yield* workspaceTool.init()
          yield* workspaceDef.execute(
            {
              algorithmName: "btc-4h-trend-following",
              symbol: "BTC.USD",
              assetClass: "crypto",
              interval: "4h",
              startDate: "2025-06-30",
              endDate: "2026-06-30",
              strategyIntent: "trend following",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const request = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")),
          )
          expect(request.requested_start).toBe("2025-06-30")
          expect(request.requested_end).toBe("2026-06-30")

          let seen: SessionPrompt.PromptInput | undefined
          const allowed = yield* taskDef.execute(
            {
              description: "BTC data extraction approved",
              prompt: "Fetch BTC 4h OHLCV from 2025-06-30 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(allowed.output).not.toContain("BLOCKED: incomplete authoritative data window")
          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- start_inclusive: 2025-06-30")
          expect(text).toContain("- end_inclusive: 2026-06-30")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("persists structured identity after a vague request is clarified through the question tool", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const vague = "Build me a strategy that can beat buy and hold; you choose the idea"
          const { chat, user, assistant } = yield* seed("Clarified strategy", vague)
          const slug = "spy-question-clarified.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const userPart: SessionV1.TextPart = {
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: user.id,
            type: "text",
            text: vague,
          }
          const questionPart: SessionV1.ToolPart = {
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: assistant.id,
            type: "tool",
            callID: "call_question_clarification",
            tool: "question",
            state: {
              status: "completed",
              input: {
                questions: [{ question: "Confirm the market, interval, and absolute backtest window." }],
              },
              output: "User has answered your questions.",
              title: "Asked 1 question",
              metadata: {
                answers: [["SPY equity, 1d bars, 2026-01-16 to 2026-07-16"]],
              },
              time: { start: 1, end: 2 },
            },
          }

          const workspaceTool = yield* WorkspacePrepareTool
          const workspaceDef = yield* workspaceTool.init()
          const result = yield* workspaceDef.execute(
            {
              algorithmName: "spy-question-clarified",
              symbol: "SPY",
              assetClass: "equity",
              interval: "1d",
              startDate: "2026-01-16",
              endDate: "2026-07-16",
              strategyIntent: "delegated",
              requestSummary: "Build the user-approved SPY strategy and beat same-window buy-and-hold.",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [
                { info: user, parts: [userPart] },
                { info: assistant, parts: [questionPart] },
              ],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.title).not.toContain("clarification")
          const request = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")),
          )
          expect(request).toMatchObject({
            requested_symbol: "SPY",
            requested_asset_class: "equity",
            requested_interval: "1d",
            requested_start: "2026-01-16",
            requested_end: "2026-07-16",
          })
          const workflows = yield* BuildWorkflowStore.listBySession(chat.id)
          expect(workflows).toHaveLength(1)
          expect(workflows[0]).toMatchObject({
            sessionId: chat.id,
            workspaceSlug: slug,
            identityStatus: "confirmed",
            identity: {
              symbols: { value: ["SPY"] },
              interval: { value: "1d" },
              assetClass: { value: "equity" },
              window: { value: { start: "2026-01-16", end: "2026-07-16" } },
            },
          })
          expect(workflows[0]!.evidenceRequirements.map((requirement) => requirement.kind)).toEqual([
            "market_data",
            "news",
          ])
          yield* workspaceDef.execute(
            {
              algorithmName: "spy-question-clarified",
              symbol: "SPY",
              assetClass: "equity",
              interval: "1d",
              startDate: "2026-01-16",
              endDate: "2026-07-16",
              strategyIntent: "delegated",
              requestSummary: "Build the user-approved SPY strategy and beat same-window buy-and-hold.",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [
                { info: user, parts: [userPart] },
                { info: assistant, parts: [questionPart] },
              ],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(yield* BuildWorkflowStore.listBySession(chat.id)).toHaveLength(1)

          const projectedTodos = yield* Effect.promise(() =>
            authoritativeWorkflowTodos({
              agent: "build",
              modelTodos: [{ content: "Collect evidence", status: "in_progress", priority: "high" }],
              load: async () => workflows,
            }),
          )
          expect(projectedTodos).toEqual([
            { content: "Collect evidence", status: "in_progress", priority: "high" },
            { content: "Confirm request identity", status: "completed", priority: "high" },
            {
              content: "Run exploratory backtest (verified evidence optional)",
              status: "pending",
              priority: "high",
            },
            { content: "Review exploratory backtest results", status: "pending", priority: "high" },
          ])
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("persists absolute dates from duration before launching data extraction", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "eth-1d-custom.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          const expected = resolveWorkspacePrepareWindow({ duration: "1y", interval: "1d" })

          const workspaceTool = yield* WorkspacePrepareTool
          const workspaceDef = yield* workspaceTool.init()
          yield* workspaceDef.execute(
            {
              algorithmName: "eth-1d-custom",
              symbol: "ETH.USD",
              assetClass: "crypto",
              interval: "1d",
              duration: "1y",
              strategyIntent: "custom",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const request = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")),
          )
          expect(request.requested_start).toBe(expected.startDate)
          expect(request.requested_end).toBe(expected.endDate)

          const taskTool = yield* TaskRunTool
          const taskDef = yield* taskTool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const result = yield* taskDef.execute(
            {
              description: "ETH one-year data extraction",
              prompt: `Fetch ETH.USD daily OHLCV from ${expected.startDate} to ${expected.endDate}.`,
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("BLOCKED: incomplete authoritative data window")
          expect(seen).toBeDefined()
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("repairs a foreign session workspace from the canonical WorkflowRun binding", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const canonical = "meta-1h-strategy.1.1.00.00"
          const foreign = "ai-1h-algo.1.1.00.01"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, canonical))

          const workspaceTool = yield* WorkspacePrepareTool
          const workspaceDef = yield* workspaceTool.init()
          const params = {
            algorithmName: "meta-hourly-strategy",
            symbol: "META",
            assetClass: "equity" as const,
            interval: "1h",
            duration: "1y",
            strategyIntent: "delegated",
            requestSummary:
              "1h META strategy using price data, news, SEC filings, and social sentiment over 1 year with $1,000 USD capital",
          }
          const context = {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }

          const first = yield* workspaceDef.execute(params, context)
          expect(first.metadata.workspaceSlug).toBe(canonical)
          expect((yield* BuildWorkflowStore.listBySession(chat.id))[0]?.workspaceSlug).toBe(canonical)

          yield* Effect.promise(async () => {
            await bindSessionWorkspace(chat.id, foreign)
            await syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug: foreign,
              prompt: "symbol AI; interval 1h; asset class equity; algorithm ai-1h-algo",
              facts: {
                requested_symbol: "AI",
                requested_interval: "1h",
                requested_asset_class: "equity",
                requested_algorithm_name: "ai-1h-algo",
              },
            })
          })
          expect(yield* Effect.promise(() => getSessionWorkspace(chat.id))).toBe(foreign)

          const repaired = yield* workspaceDef.execute(params, context)
          expect(repaired.metadata.workspaceSlug).toBe(canonical)
          expect(repaired.output).toContain(`workspace_slug: ${canonical}`)
          expect(yield* Effect.promise(() => getSessionWorkspace(chat.id))).toBe(canonical)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("caps intraday data_extractor context at the last completed UTC date", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "eth-1h-mean-reversion.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const today = new Date().toISOString().slice(0, 10)
          const yesterday = new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
          )
          yesterday.setUTCDate(yesterday.getUTCDate() - 1)
          const yesterdayIso = yesterday.toISOString().slice(0, 10)

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "ETH data extraction",
              prompt: `Extract ETHUSDT 1h data from 2025-06-16 to ${today}.`,
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- interval: 1h")
          expect(text).toContain(`- end_inclusive: ${yesterdayIso}`)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("reuses verified data_extractor manifest for an already completed intraday window", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "eth-1h-mean-reversion.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const today = new Date().toISOString().slice(0, 10)
          const yesterday = new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
          )
          yesterday.setUTCDate(yesterday.getUTCDate() - 1)
          const yesterdayIso = yesterday.toISOString().slice(0, 10)
          const dataDir = path.join(algoDir(slug), "data", "crypto")
          const csvRel = `crypto/ETHUSDT_1h_2025-06-16_${yesterdayIso}.csv`
          const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
          yield* Effect.promise(() => fs.mkdir(dataDir, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(algoDir(slug), "data", csvRel),
              `timestamp,open,high,low,close,volume\n2025-06-16T00:00:00Z,100,110,90,105,1000\n${yesterdayIso}T00:00:00Z,105,115,95,110,1000\n`,
              "utf8",
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(algoDir(slug), "data", manifestRel),
              JSON.stringify(
                {
                  schema_version: 1,
                  source: "binance",
                  requested_symbol: "ETH",
                  actual_symbol: "ETHUSDT",
                  requested_interval: "1h",
                  actual_interval: "1h",
                  requested_asset_class: "crypto",
                  actual_asset_class: "crypto",
                  requested_algorithm_name: "eth-1h-mean-reversion",
                  requested_start: "2025-06-16",
                  requested_end: yesterdayIso,
                  actual_start: "2025-06-16T00:00:00Z",
                  actual_end: `${yesterdayIso}T00:00:00Z`,
                  output_path: csvRel,
                  rows: 2,
                  run_id: "reuse-existing",
                  coverage: "complete",
                  usable_for_parent: "yes",
                },
                null,
                2,
              ),
              "utf8",
            ),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "ETH data extraction retry",
              prompt: `Extract ETHUSDT 1h data from 2025-06-16 to ${today}.`,
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(prompted).toBe(false)
          expect(result.output).toContain("reusing verified workspace artifacts")
          expect(result.output).toContain("usable_for_parent: yes")
          expect(result.output).toContain(`requested_end: ${yesterdayIso}`)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("blocks explicit data_extractor target that conflicts with the bound workspace", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-1h-mean-reversion.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Extract SPY 1h equity data from 2026-03-30 to 2026-06-30.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "SMH data extraction retry",
              prompt: "Extract SMH 1h equity data from 2026-03-30 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(prompted).toBe(false)
          expect(result.output).toContain("BLOCKED: data request context mismatch")
          expect(result.output).toContain("SMH 1h equity")
          expect(result.output).toContain(`workspace_slug=${slug}`)
          expect(result.output).toContain("do not reuse existing workspace artifacts")
          expect(result.output).toContain("did not terminalize this Build run")

          let correctedPrompted = false
          yield* def.execute(
            {
              description: "SPY data extraction retry",
              prompt: "Extract SPY 1h equity data from 2026-03-30 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: () => (correctedPrompted = true) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(correctedPrompted).toBe(true)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("blocks curated data_extractor target that conflicts with a non-curated workspace symbol", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "smh-1h-momentum.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Extract SMH 1h equity data from 2026-03-30 to 2026-06-30.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "QQQ data extraction retry",
              prompt: "Extract QQQ 1h equity data from 2026-03-30 to 2026-06-30.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(prompted).toBe(false)
          expect(result.output).toContain("BLOCKED: data request context mismatch")
          expect(result.output).toContain("QQQ 1h equity")
          expect(result.output).toContain("workspace_symbol=SMH")
          expect(result.output).toContain("do not reuse existing workspace artifacts")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("does not treat random workspace hash suffixes as interval facts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          // Hash ends in `27d` which parseRequestFacts would invent as interval 27d
          // if the full slug (not just the base name) is scanned.
          const slug = "spy-strategy.11.7.01.04.6292a27d"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Extract SPY 5m equity data from 2026-01-09 to 2026-07-08.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let prompted = false
          const promptOps = stubOps({ onPrompt: () => (prompted = true) })

          const result = yield* def.execute(
            {
              description: "Extract deterministic SPY evidence",
              prompt:
                "Data request context: algorithm spy-sma-crossover; symbol SPY; equity; interval 5m; start date 2026-01-09; end date 2026-07-08. Materialize and verify the configured harness fixture.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("workspace_interval=27d")
          expect(result.output).not.toContain("BLOCKED: data request context mismatch")
          expect(prompted).toBe(true)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("passes requested algorithm name separately from workspace slug", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-strategy.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "SPY data extraction",
              prompt:
                "Extract SPY 5-minute equity data from 2026-05-15 to 2026-06-14. Name it spy-5m-product-demo-20260614-v2.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain(`- output_dir: ${path.join(algoDir(slug), "data")}`)
          expect(text).toContain("Name it spy-5m-product-demo-20260614-v2")
          expect(text).toContain("- algorithm: spy-5m-product-demo-20260614-v2")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("overrides stale workspace algorithm name from explicit existing algorithm prompt", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "p500-1hr-trade-1h-strategy.22.6.00.39.0f9d37af"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt:
                "Extract SPY 1h equity data from 2025-12-22 to 2026-06-21. requested_algorithm_name=p500-1hr-trade-1h-strategy",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "SPY robustness data",
              prompt:
                "Data request context: Build is improving EXISTING algorithm `spy-1h-momentum-breakout` v2 for SPY ETF, asset_class equity, interval 1h, full window 2025-12-22 to 2026-06-21.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain(`- output_dir: ${path.join(algoDir(slug), "data")}`)
          expect(text).toContain("spy-1h-momentum-breakout")
          expect(text).toContain("- algorithm: spy-1h-momentum-breakout")
          const persisted = yield* Effect.promise(() =>
            fs.readFile(path.join(algoDir(slug), "request.json"), "utf8").then(JSON.parse),
          )
          expect(persisted.requested_algorithm_name).toBe("spy-1h-momentum-breakout")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("reuses workspace request context when resuming data_extractor tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-resume.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Extract 5-minute OHLCV data for SPY from 2026-03-10 to 2026-06-10.",
            }),
          )
          const child = yield* sessions.create({ parentID: chat.id, title: "Resume data extractor" })

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "Continue SPY data extraction",
              prompt: "continue",
              subagent_type: "data_extractor",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: SPY")
          expect(text).toContain("- interval: 5m")
          expect(text).toContain("- start_inclusive: 2026-03-10")
          expect(text).toContain("- end_inclusive: 2026-06-10")
          expect(text).toContain(`- output_dir: ${path.join(algoDir(slug), "data")}`)
          expect(text).not.toContain("- symbols: MISSING")
          expect(text).not.toContain("- interval: MISSING")
          expect(text).not.toContain("- start_inclusive: MISSING")
          expect(text).not.toContain("- end_inclusive: MISSING")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("blocks completed data_extractor tasks that only produced header-only CSV artifacts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-empty.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          const csv = path.join(algoDir(slug), "data", "stock", "SPY_5m_2026-03-13_2026-06-13.csv")
          yield* Effect.promise(() => fs.mkdir(path.dirname(csv), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(csv, "timestamp,open,high,low,close,volume\n", "utf8"))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          const promptOps = stubOps({ text: `## Data Complete\nartifact_paths: ${csv}` })

          const result = yield* def.execute(
            {
              description: "SPY data extraction",
              prompt: "Extract SPY 5-minute data from 2026-03-13 to 2026-06-13.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).toContain("BLOCKED: data_extractor returned unusable CSV evidence")
          expect(result.output).toContain("artifact has no data rows")
          expect(result.output).toContain(csv)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("batch mode returns news output even when data validation blocks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-15m-batch.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          const seenAgents: string[] = []
          const metadataUpdates: Array<{ title?: string; metadata?: Record<string, any> }> = []
          const promptOps = stubOps({ onPrompt: (input) => seenAgents.push(input.agent ?? "") })
          const tool = yield* TaskBatchRunTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              tasks: [
                {
                  description: "Extract SPY data",
                  prompt: "Extract SPY equity 15m data from 2026-03-21 to 2026-06-18.",
                  subagent_type: "data_extractor",
                },
                {
                  description: "Research SPY news",
                  prompt: "Research current SPY equity 15m execution context.",
                  subagent_type: "news_agent",
                },
                {
                  description: "Research SPY sentiment",
                  prompt: "Research SPY equity 15m social sentiment from 2026-03-21 to 2026-06-18.",
                  subagent_type: "sentiment_agent",
                },
                {
                  description: "Research SPY SEC filings",
                  prompt: "Research SPY ETF SEC filings and holdings context.",
                  subagent_type: "sec_agent",
                },
              ],
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: (input) =>
                Effect.sync(() => {
                  metadataUpdates.push(input)
                }),
              ask: () => Effect.void,
            },
          )

          expect(seenAgents.sort()).toEqual(["data_extractor", "news_agent", "sec_agent", "sentiment_agent"])
          expect(result.output).toContain('<task_batch state="completed">')
          expect(result.output).toContain('subagent_type="data_extractor"')
          expect(result.output).toContain("BLOCKED: data_extractor returned incomplete evidence artifacts")
          expect(result.output).toContain('subagent_type="news_agent"')
          expect(result.output).toContain('subagent_type="sec_agent"')
          expect(result.output).toContain('subagent_type="sentiment_agent"')
          expect(result.output).toContain("done")
          expect(result.metadata.batch).toBe(true)
          expect(result.metadata.subagents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                subagentType: "data_extractor",
                description: "Extract SPY data",
                state: "completed",
              }),
              expect.objectContaining({
                subagentType: "news_agent",
                description: "Research SPY news",
                state: "completed",
              }),
              expect.objectContaining({
                subagentType: "sec_agent",
                description: "Research SPY SEC filings",
                state: "completed",
              }),
              expect.objectContaining({
                subagentType: "sentiment_agent",
                description: "Research SPY sentiment",
                state: "completed",
              }),
            ]),
          )
          expect(metadataUpdates).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                title: "Mandatory evidence batch",
                metadata: expect.objectContaining({
                  batch: true,
                  subagents: expect.arrayContaining([
                    expect.objectContaining({
                      subagentType: "data_extractor",
                      description: "Extract SPY data",
                      state: "running",
                    }),
                  ]),
                }),
              }),
              expect.objectContaining({
                title: "Mandatory evidence batch",
                metadata: expect.objectContaining({
                  batch: true,
                  subagents: expect.arrayContaining([
                    expect.objectContaining({
                      subagentType: "news_agent",
                      description: "Research SPY news",
                      state: "running",
                    }),
                  ]),
                }),
              }),
            ]),
          )
          const database = yield* Database.Service
          const tasks = yield* Effect.promise(() => TaskState.listByParent(chat.id, database))
          expect(tasks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                subagentType: "data_extractor",
                description: "Extract SPY data",
                mode: "foreground",
                status: TaskState.Status.blocked,
              }),
              expect.objectContaining({
                subagentType: "news_agent",
                description: "Research SPY news",
                mode: "foreground",
                status: TaskState.Status.completed,
              }),
              expect.objectContaining({
                subagentType: "sec_agent",
                description: "Research SPY SEC filings",
                mode: "foreground",
                status: TaskState.Status.completed,
              }),
              expect.objectContaining({
                subagentType: "sentiment_agent",
                description: "Research SPY sentiment",
                mode: "foreground",
                status: TaskState.Status.completed,
              }),
            ]),
          )
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("batch mode returns verified data with an empty-current-context news result", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-15m-batch-success.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          const durableWorkflow = yield* BuildWorkflowStore.insert({
            workflowId: `wf_${chat.id}`,
            sessionId: chat.id,
            workspaceSlug: slug,
            intent: "build",
            marketDataRequired: true,
            identity: {
              symbols: { value: ["SPY"], source: { kind: "structured_tool", tool: "test", callId: "call_spy" } },
              interval: { value: "15m", source: { kind: "structured_tool", tool: "test", callId: "call_spy" } },
              assetClass: {
                value: "equity",
                source: { kind: "structured_tool", tool: "test", callId: "call_spy" },
              },
              algorithmName: {
                value: "spy-batch-success",
                source: { kind: "structured_tool", tool: "test", callId: "call_spy" },
              },
              window: {
                value: { start: "2026-03-23", end: "2026-06-17" },
                source: { kind: "structured_tool", tool: "test", callId: "call_spy" },
              },
            },
          })
          const dataDir = path.join(algoDir(slug), "data", "stock")
          const csv = path.join(dataDir, "SPY_15m_2026-03-23_2026-06-17.csv")
          const manifestFile = path.join(dataDir, "SPY_15m_2026-03-23_2026-06-17.manifest.json")
          yield* Effect.promise(() => fs.mkdir(dataDir, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              csv,
              "timestamp,open,high,low,close,volume\n2026-03-23T12:00:00Z,1,2,1,2,100\n2026-06-17T20:00:00Z,2,3,2,3,100\n",
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              manifestFile,
              JSON.stringify({
                schema_version: 1,
                source: "alpaca",
                requested_symbol: "SPY",
                actual_symbol: "SPY",
                requested_interval: "15m",
                actual_interval: "15m",
                requested_asset_class: "equity",
                actual_asset_class: "equity",
                requested_algorithm_name: "spy-batch-success",
                requested_start: "2026-03-23",
                requested_end: "2026-06-17",
                actual_start: "2026-03-23T12:00:00Z",
                actual_end: "2026-06-17T20:00:00Z",
                output_path: "stock/SPY_15m_2026-03-23_2026-06-17.csv",
                rows: 2,
                run_id: "batch-success",
                coverage: "trading_day_complete",
              }),
            ),
          )

          const dataText = [
            "requested_algorithm_name: spy-batch-success",
            `workspace_slug: ${slug}`,
            "requested_symbol: SPY",
            "actual_symbol: SPY",
            "requested_interval: 15m",
            "actual_interval: 15m",
            "requested_asset_class: equity",
            "actual_asset_class: equity",
            "requested_start: 2026-03-23",
            "requested_end: 2026-06-17",
            "actual_start: 2026-03-23T12:00:00Z",
            "actual_end: 2026-06-17T20:00:00Z",
            `artifact_paths: ${csv}, ${manifestFile}`,
            "run_id: batch-success",
          ].join("\n")
          const promptOps = stubOps({
            text: (input) => (input.agent === "data_extractor" ? dataText : "no material current context found"),
          })
          const tool = yield* TaskBatchRunTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              tasks: [
                {
                  description: "Extract SPY data",
                  prompt: "Extract SPY equity 15m data from 2026-03-23 to 2026-06-17. Name it spy-batch-success.",
                  subagent_type: "data_extractor",
                },
                {
                  description: "Research SPY news",
                  prompt: "Research current SPY equity 15m execution context.",
                  subagent_type: "news_agent",
                },
              ],
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("BLOCKED:")
          expect(result.output).toContain("usable_for_parent: yes")
          expect(result.output).toContain("NO_SOURCED_CONTEXT")
          expect(yield* BuildWorkflowStore.get(durableWorkflow.workflowId)).toMatchObject({
            status: "active",
            phase: "evidence_ready",
            evidence: [
              expect.objectContaining({
                requirementId: "market_data:SPY",
                kind: "market_data",
                status: "verified",
              }),
            ],
          })
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("injects authoritative workspace context for news_agent tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-strategy.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "SPY regime research",
              prompt: "Research current market context for SPY 5-minute equity strategy.",
              subagent_type: "news_agent",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("<finny-subagent-context>")
          expect(text).toContain("- requested_symbol: SPY")
          expect(text).toContain("- requested_interval: 5m")
          expect(text).toContain("- requested_asset_class: equity")
          expect(text).toContain(`- workspace_news_dir: ${path.join(algoDir(slug), "data", "news")}`)
          expect(text).toContain("Write at most one note directly under `workspace_news_dir`")
          expect(text).toContain("follow the News Agent evidence contract")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("retries malformed news output once in the same child and records verified durable evidence", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed(undefined, "Build a new BTC.USD daily strategy with news context.")
          const slug = "btc-usd-1d-news-retry.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          const durableWorkflow = yield* BuildWorkflowStore.insert({
            workflowId: `wf_${chat.id}`,
            sessionId: chat.id,
            workspaceSlug: slug,
            intent: "build",
            marketDataRequired: false,
            newsRequired: true,
            identity: {
              symbols: { value: ["BTC.USD"], source: { kind: "user_message", messageId: assistant.parentID } },
              interval: { value: "1d", source: { kind: "user_message", messageId: assistant.parentID } },
              assetClass: { value: "crypto", source: { kind: "user_message", messageId: assistant.parentID } },
            },
          })
          yield* BuildWorkflowStore.append({
            workflowId: durableWorkflow.workflowId,
            expectedRevision: durableWorkflow.revision,
            event: {
              id: `evt_market_${chat.id}`,
              type: "evidence.recorded",
              occurredAt: Date.now(),
              source: { actor: "tool" },
              evidence: {
                id: "market_data:BTC:fixture",
                requirementId: "market_data:BTC",
                kind: "market_data",
                status: "verified",
                artifactId: "fixture-market-hash",
                issues: [],
              },
            },
          })
          const childSessions: string[] = []
          const childPrompts: string[] = []
          let promptCount = 0
          const retrievedAt = new Date().toISOString()
          const validClaims = [
            "Corrected sourced context.",
            "```json",
            JSON.stringify({
              schema: "finny.news.claims.v1",
              result: "OK",
              identity: {
                requested_symbol: "BTC.USD",
                requested_interval: "1d",
                requested_asset_class: "crypto",
              },
              retrieved_at: retrievedAt,
              claims: [
                {
                  class: "sourced_fact",
                  statement: "The exchange published a BTC market notice.",
                  source_url: "https://example.com/btc-notice",
                  provider: "Example Exchange",
                  published_at: retrievedAt,
                  retrieved_at: retrievedAt,
                  excerpt: "BTC market notice",
                },
              ],
            }),
            "```",
          ].join("\n")
          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          const result = yield* def.execute(
            {
              description: "Research BTC news",
              prompt: "Research BTC.USD crypto 1d news context.",
              subagent_type: "news_agent",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: stubOps({
                  onPrompt: (input) => {
                    childSessions.push(input.sessionID)
                    childPrompts.push(
                      input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
                    )
                  },
                  text: () => (++promptCount === 1 ? "Readable prose without the required claims block." : validClaims),
                }),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(promptCount).toBe(2)
          expect(new Set(childSessions).size).toBe(1)
          expect(childPrompts[1]).toContain('"claims"')
          expect(childPrompts[1]).toContain('"class":"sourced_fact"')
          expect(childPrompts[1]).toContain("do not use top-level sourced_facts")
          expect(result.output).toContain("result: OK")
          const finishedWorkflow = yield* BuildWorkflowStore.get(durableWorkflow.workflowId)
          expect(finishedWorkflow).toMatchObject({
            stage: "evidence_ready",
            phase: "evidence_ready",
          })
          expect(finishedWorkflow?.evidence.find((record) => record.requirementId === "news:request")).toMatchObject({
            kind: "news",
            status: "verified",
            sourceSessionId: childSessions[0],
          })
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("keeps auxiliary VIX research in the authoritative SPY workspace", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-1d-momentum.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "Build SPY equity 1d from 2026-01-15 to 2026-07-15.",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const result = yield* def.execute(
            {
              description: "Gather SPY market context",
              prompt:
                "Research current SPY market context: recent performance, support/resistance, VIX regime, and major catalysts. Focus on the last 2-4 weeks.",
              subagent_type: "news_agent",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("data request context mismatch")
          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- requested_symbol: SPY")
          expect(text).toContain("- requested_interval: 1d")
          expect(yield* Effect.promise(() => getSessionWorkspace(seen!.sessionID))).toBe(slug)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("injects authoritative workspace context for sentiment_agent tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "aapl-sentiment-breakout.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "AAPL sentiment check",
              prompt: "Research AAPL equity 1d social sentiment from 2026-06-01 to 2026-06-29.",
              subagent_type: "sentiment_agent",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("<finny-subagent-context>")
          expect(text).toContain("Authoritative sentiment artifact context:")
          expect(text).toContain("- symbol: AAPL")
          expect(text).toContain("- interval: 1d")
          expect(text).toContain("- asset_class: equity")
          expect(text).toContain("- start_date: 2026-06-01")
          expect(text).toContain("- end_date: 2026-06-29")
          expect(text).toContain("- end_date_inclusive: true")
          expect(text).toContain(`- workspace: ${path.join(algoDir(slug), "data", "sentiment")}`)
          expect(text).toContain(`- allowed_sentiment_dir: ${path.join(algoDir(slug), "data", "sentiment")}`)
          expect(text).toContain(
            `- expected_sentiment_csv_path: ${path.join(algoDir(slug), "data", "sentiment", "AAPL_2026-06-01_2026-06-29_sentiment.csv")}`,
          )
          expect(text).toContain(
            `- expected_sentiment_manifest_path: ${path.join(algoDir(slug), "data", "sentiment", "AAPL_2026-06-01_2026-06-29_sentiment.manifest.json")}`,
          )
          expect(text).toContain("Use the expected paths for useful aggregate artifacts")
          expect(text).toContain("raw social text must remain transient")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("injects authoritative SEC context for sec_agent tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "msft-insider.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "MSFT insider filings",
              prompt:
                "Did Bill Gates sell Microsoft stock between 2024-01-01 and 2024-03-31? Gather Form 4 insider transactions.",
              subagent_type: "sec_agent",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("<finny-subagent-context>")
          expect(text).toContain("Authoritative SEC artifact context:")
          expect(text).toContain("- company_or_ticker: Microsoft")
          expect(text).toContain("- person: Bill Gates")
          expect(text).toContain("- start_date: 2024-01-01")
          expect(text).toContain("- end_date: 2024-03-31")
          expect(text).toContain("- end_date_inclusive: true")
          expect(text).toContain(`- workspace: ${path.join(algoDir(slug), "data", "sec")}`)
          expect(text).toContain(`- allowed_sec_dir: ${path.join(algoDir(slug), "data", "sec")}`)
          expect(text).toContain("follow the SEC Agent evidence contract")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("keeps SEC form names such as 10-K in the authoritative TD workspace", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "td-1h-strategy.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))
          yield* Effect.promise(() =>
            syncWorkspaceRequestContext({
              sessionID: chat.id,
              slug,
              prompt: "symbol TD; interval 1h; asset class equity; date window 2025-07-21 to 2026-07-21",
            }),
          )

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const result = yield* def.execute(
            {
              description: "Gather SEC EDGAR filings for TD",
              subagent_type: "sec_agent",
              prompt:
                "Fetch SEC EDGAR filings (10-K, 10-Q, 8-K, Form 4) for TD (Toronto-Dominion Bank). Return filings analysis.",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(result.output).not.toContain("context mismatch")
          expect(yield* Effect.promise(() => getSessionWorkspace(chat.id))).toBe(slug)
          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- resolved_symbol: TD")
          expect(text).toContain(path.join(algoDir(slug), "data/sec"))
          expect(text).not.toContain("/k-algo.")
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.live("bootstraps workspace for unbound Finny subagent tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          yield* Effect.promise(() => clearSessionWorkspace(chat.id).catch(() => {}))

          const tool = yield* TaskRunTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          const result = yield* def.execute(
            {
              description: "MSFT daily data",
              prompt: "Extract MSFT 1d equity data from 2026-01-01 to 2026-06-30 for a mean reversion strategy.",
              subagent_type: "data_extractor",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const jobs = yield* BackgroundJob.Service
          yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })

          const childSession = seen?.sessionID
          expect(childSession).toBeDefined()
          const parentWorkspace = yield* Effect.promise(() => getSessionWorkspace(chat.id))
          const childWorkspace = yield* Effect.promise(() => getSessionWorkspace(childSession!))
          expect(parentWorkspace).not.toBeNull()
          expect(parentWorkspace).toContain("msft-1d-mean-reversion")
          expect(childWorkspace).toBe(parentWorkspace)

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols: MSFT")
          expect(text).toContain("- interval: 1d")
          expect(text).toContain(`- output_dir: ${path.join(algoDir(parentWorkspace!), "data")}`)
        } finally {
          if (prev === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = prev
        }
      }),
    ),
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskRunTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("task_start launches background execution without an experiment flag", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain('state="running"')
    }),
  )

  it.instance("task_start keeps recommended data_extractor work in the background", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "Extract SPY data",
          prompt: "Extract SPY equity 15m data from 2026-01-15 to 2026-07-15.",
          subagent_type: "data_extractor",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain('state="running"')
    }),
  )

  it.instance("task_run does not block the parent for recommended new-build evidence", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 5m strategy")
      const tool = yield* TaskRunTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "Research SPY news context",
          prompt: "Research current SPY news context for the new strategy.",
          subagent_type: "news_agent",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: { ...stubOps(), prompt: () => Effect.never } },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain('state="running"')
    }),
  )

  it.instance("batch metadata keeps background children running", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      const tool = yield* TaskBatchRunTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          tasks: [
            {
              description: "Research SPY news",
              prompt: "Research SPY news for the new strategy.",
              subagent_type: "news_agent",
            },
            {
              description: "Research SPY sentiment",
              prompt: "Research SPY sentiment for the new strategy.",
              subagent_type: "sentiment_agent",
            },
          ],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: { ...stubOps(), prompt: () => Effect.never } },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('<task_batch state="running">')
      expect(result.metadata.subagents?.map((task) => task.state)).toEqual(["running", "running"])
    }),
  )

  it.instance("reuses an active evidence role instead of launching a duplicate", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const active = yield* sessions.create({ parentID: chat.id, title: "Existing SPY extraction" })
      const activeID = active.id
      yield* Effect.promise(() =>
        TaskState.upsert(
          {
            id: activeID,
            parentSessionID: chat.id,
            description: "Existing SPY extraction",
            subagentType: "data_extractor",
            mode: "background",
            status: TaskState.Status.running,
          },
          database,
        ),
      )
      let prompted = false
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "Duplicate SPY extraction",
          prompt: "Extract SPY 1d data for the new strategy.",
          subagent_type: "data_extractor",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(prompted).toBe(false)
      expect(result.metadata.sessionId).toBe(activeID)
      expect(result.output).toContain("Existing background task reused")
    }),
  )

  it.instance("returns active background task status without extending the child", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      const startTool = yield* TaskStartTool
      const start = yield* startTool.init()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: () => Effect.never,
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const launched = yield* start.execute(
        {
          description: "Inspect cache behavior",
          prompt: "Inspect the cache behavior and report findings.",
          subagent_type: "general",
        },
        context,
      )
      const originalExtend = jobs.extend
      let extendCalls = 0
      ;(jobs as { extend: typeof jobs.extend }).extend = (input) => {
        extendCalls += 1
        return originalExtend(input)
      }

      const runTool = yield* TaskRunTool
      const run = yield* runTool.init()
      const result = yield* run.execute(
        {
          description: "Get general result",
          prompt: "Fetch output of background general task.",
          subagent_type: "general",
          task_id: launched.metadata.sessionId,
        },
        context,
      )

      expect(extendCalls).toBe(0)
      expect(result.metadata.sessionId).toBe(launched.metadata.sessionId)
      expect(result.output).toContain("will be delivered automatically")
      expect(result.output).toContain('state="running"')
    }),
  )

  it.instance("does not re-steer an active Build context task through explicit task_id", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new BTC 1d strategy")
      const active = yield* sessions.create({ parentID: chat.id, title: "BTC data context" })
      yield* Effect.promise(() =>
        TaskState.upsert(
          {
            id: active.id,
            parentSessionID: chat.id,
            description: "BTC daily data",
            subagentType: "data_extractor",
            mode: "background",
            status: TaskState.Status.running,
          },
          database,
        ),
      )
      let prompted = false
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "BTC daily data",
          prompt:
            "Continue and finish the previously started BTC/USD daily data extraction task. Return the final structured digest only.",
          subagent_type: "data_extractor",
          task_id: active.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(prompted).toBe(false)
      expect(result.metadata.sessionId).toBe(active.id)
      expect(result.output).toContain("authoritative launch context")
      expect(result.output).toContain("do not poll, re-steer, extend, restart, or duplicate")
      expect(result.output).not.toContain("Additional context sent")
    }),
  )

  it.instance("requires a fresh child when retrying a terminal Build context task", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new BTC 1d strategy")
      const terminal = yield* sessions.create({ parentID: chat.id, title: "BTC news context" })
      yield* Effect.promise(() =>
        TaskState.upsert(
          {
            id: terminal.id,
            parentSessionID: chat.id,
            description: "BTC news context",
            subagentType: "news_agent",
            mode: "background",
            status: TaskState.Status.completed,
            resultSummary: "NO_SOURCED_CONTEXT",
          },
          database,
        ),
      )
      let prompted = false
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "Retry BTC news context",
          prompt: "Retry structured sources and return only verified claims.",
          subagent_type: "news_agent",
          task_id: terminal.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: () => (prompted = true) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(prompted).toBe(false)
      expect(result.metadata.sessionId).toBeUndefined()
      expect(result.output).toContain("terminal news_agent task")
      expect(result.output).toContain("without task_id")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("blocks strategy scaffolding while context subagents are active", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const active = yield* sessions.create({ parentID: chat.id, title: "Existing SPY news research" })
      yield* Effect.promise(() =>
        TaskState.upsert(
          {
            id: active.id,
            parentSessionID: chat.id,
            description: "Existing SPY news research",
            subagentType: "news_agent",
            mode: "background",
            status: TaskState.Status.running,
          },
          database,
        ),
      )
      let asked = false
      const tool = yield* AlgorithmScaffoldTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { template_type: "custom" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.sync(() => (asked = true)),
        },
      )

      expect(asked).toBe(false)
      expect(result.metadata.blocked).toBe(true)
      expect(result.output).toContain("must wait for the active strategy-context subagents")
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskRunTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background task completion retries when parent session is busy", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      let parentAttempts = 0

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                if (input.sessionID !== chat.id) return Effect.succeed(reply(input, "background done"))
                parentAttempts++
                if (parentAttempts === 1) return Effect.die(new Session.BusyError({ sessionID: chat.id }))
                injected.resolve(input)
                return Effect.succeed(reply(input, "delivered"))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(parentAttempts).toBe(2)
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("background done")
    }),
  )

  background.instance(
    "waits beyond the old retry budget and delivers a completion exactly once when the parent becomes idle",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const database = yield* Database.Service
        const status = yield* SessionStatus.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskStartTool
        const def = yield* tool.init()
        const injected = defer<SessionPrompt.PromptInput>()
        let parentAttempts = 0
        let parentDeliveries = 0

        yield* status.set(chat.id, { type: "busy" })
        const result = yield* def.execute(
          {
            description: "inspect long parent turn",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) => {
                  if (input.sessionID !== chat.id) return Effect.succeed(reply(input, "background done"))
                  parentAttempts++
                  return status.get(chat.id).pipe(
                    Effect.flatMap((current) => {
                      if (current.type !== "idle") return Effect.die(new Session.BusyError({ sessionID: chat.id }))
                      parentDeliveries++
                      injected.resolve(input)
                      return Effect.succeed(reply(input, "delivered"))
                    }),
                  )
                },
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
        expect(waited.info?.status).toBe("completed")
        yield* Effect.sleep("1200 millis")
        expect(parentAttempts).toBe(0)
        expect(parentDeliveries).toBe(0)
        expect((yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status).toBe(
          TaskState.Status.running,
        )

        yield* status.set(chat.id, { type: "idle" })
        const notification = yield* Effect.promise(() => injected.promise)
        expect(notification.parts[0]?.type).toBe("text")
        if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("background done")
        while (
          (yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status ===
          TaskState.Status.running
        ) {
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.sleep("200 millis")
        expect(parentAttempts).toBe(1)
        expect(parentDeliveries).toBe(1)
        expect((yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status).toBe(
          TaskState.Status.completed,
        )
      }),
  )

  background.instance("keeps strategy synthesis blocked until context completion reaches the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      const tool = yield* TaskStartTool
      const def = yield* tool.init()
      const deliveryStarted = yield* Deferred.make<void>()
      const allowDelivery = yield* Deferred.make<void>()
      let deliveryInput: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "research SPY market context",
          prompt: "Research SPY market context for a new daily strategy.",
          subagent_type: "news_agent",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                if (input.sessionID !== chat.id) return Effect.succeed(reply(input, "context complete"))
                deliveryInput = input
                return Deferred.succeed(deliveryStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowDelivery)),
                  Effect.as(reply(input, "completion delivered")),
                )
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      yield* Deferred.await(deliveryStarted)
      expect((yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status).toBe(
        TaskState.Status.running,
      )
      expect(
        (yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database))).map((task) => task.id),
      ).toEqual([result.metadata.sessionId])
      const deliveryMessageID = MessageID.ascending()
      const deliveredMessages = [
        {
          info: {
            id: deliveryMessageID,
            sessionID: chat.id,
            role: "user" as const,
            agent: "finny",
            model: ref,
            time: { created: Date.now() },
          },
          parts: (deliveryInput?.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => ({
              id: PartID.ascending(),
              sessionID: chat.id,
              messageID: deliveryMessageID,
              type: "text" as const,
              text: part.type === "text" ? part.text : "",
              ...(part.type === "text" && part.synthetic !== undefined ? { synthetic: part.synthetic } : {}),
            })),
        },
      ] as SessionV1.WithParts[]
      expect(yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database, deliveredMessages))).toEqual(
        [],
      )

      const guardContext = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "finny",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const deliveredGuardContext = { ...guardContext, messages: deliveredMessages }
      const boundWorkspace = yield* Effect.promise(() => getSessionWorkspace(chat.id))
      expect(boundWorkspace).not.toBeNull()
      const workspacePath = algoDir(boundWorkspace!)
      expect(isStrategySynthesisPath(workspacePath, path.join(workspacePath, "edge_analysis.md"))).toBe(true)
      for (const file of [
        path.join(workspacePath, "edge_analysis.md"),
        path.join(workspacePath, "v01", "strategy.py"),
        path.join(workspacePath, "v01", "config.json"),
      ]) {
        const blockedWrite = yield* Effect.exit(assertFinnyWorkspacePathPolicy(guardContext, file, "write", database))
        expect(Exit.isFailure(blockedWrite)).toBe(true)
        if (Exit.isFailure(blockedWrite)) {
          expect(Cause.pretty(blockedWrite.cause)).toContain("must wait for the active strategy-context subagents")
        }
      }
      for (const file of [
        path.join(workspacePath, "mission.md"),
        path.join(workspacePath, "todo.md"),
        path.join(workspacePath, "analysis", "setup.py"),
      ]) {
        yield* assertFinnyWorkspacePathPolicy(guardContext, file, "write", database)
      }

      let asked = false
      const scaffold = yield* AlgorithmScaffoldTool
      const scaffoldDef = yield* scaffold.init()
      const blocked = yield* scaffoldDef.execute(
        { template_type: "custom" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.sync(() => (asked = true)),
        },
      )
      expect(asked).toBe(false)
      expect(blocked.metadata.blocked).toBe(true)

      // Admission of this synthetic completion turn is enough to release the
      // matching gate even though TaskState remains running until ops.prompt
      // returns successfully.
      yield* assertFinnyWorkspacePathPolicy(
        deliveredGuardContext,
        path.join(workspacePath, "edge_analysis.md"),
        "write",
        database,
      )
      const admitted = yield* scaffoldDef.execute(
        { template_type: "custom" },
        {
          ...deliveredGuardContext,
          ask: () => Effect.void,
        },
      )
      expect(admitted.metadata.blocked).toBe(false)
      expect((yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status).toBe(
        TaskState.Status.running,
      )

      const sessions = yield* Session.Service
      const unrelated = yield* sessions.create({ parentID: chat.id, title: "Unrelated context" })
      yield* Effect.promise(() =>
        TaskState.upsert(
          {
            id: unrelated.id,
            parentSessionID: chat.id,
            description: "unrelated sentiment context",
            subagentType: "sentiment_agent",
            mode: "background",
            status: TaskState.Status.running,
            startedAt: Date.now(),
          },
          database,
        ),
      )
      expect(
        (yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database, deliveredMessages))).map(
          (task) => task.id,
        ),
      ).toEqual([unrelated.id])
      const unrelatedBlocked = yield* Effect.exit(
        assertFinnyWorkspacePathPolicy(
          deliveredGuardContext,
          path.join(workspacePath, "edge_analysis.md"),
          "write",
          database,
        ),
      )
      expect(Exit.isFailure(unrelatedBlocked)).toBe(true)
      yield* Effect.promise(() =>
        TaskState.finalizeActive(unrelated.id, { status: TaskState.Status.cancelled }, database),
      )

      yield* Deferred.succeed(allowDelivery, undefined)
      while (
        (yield* Effect.promise(() => TaskState.get(result.metadata.sessionId, database)))?.status ===
        TaskState.Status.running
      ) {
        yield* Effect.sleep("10 millis")
      }
      expect(yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database))).toEqual([])
      yield* assertFinnyWorkspacePathPolicy(
        guardContext,
        path.join(workspacePath, "edge_analysis.md"),
        "write",
        database,
      )
    }),
  )

  background.instance("waits for the full context set before releasing synthesis", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      yield* Effect.promise(() => bindSessionWorkspace(chat.id, "issue-40-wait-test"))
      const first = yield* sessions.create({ parentID: chat.id, title: "SPY data context" })
      const second = yield* sessions.create({ parentID: chat.id, title: "SPY news context" })
      const firstDone = yield* Deferred.make<void>()
      const secondDone = yield* Deferred.make<void>()

      for (const task of [
        { id: first.id, subagentType: "data_extractor", description: "SPY data context" },
        { id: second.id, subagentType: "news_agent", description: "SPY news context" },
      ]) {
        yield* Effect.promise(() =>
          TaskState.upsert(
            {
              ...task,
              parentSessionID: chat.id,
              mode: "background",
              status: TaskState.Status.running,
              startedAt: Date.now(),
            },
            database,
          ),
        )
      }
      yield* jobs.start({
        id: first.id,
        type: "task",
        run: Deferred.await(firstDone).pipe(Effect.as("data context complete")),
      })
      yield* jobs.start({
        id: second.id,
        type: "task",
        run: Deferred.await(secondDone).pipe(Effect.as("news context complete")),
      })

      const captured = yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database))
      const waitStarted = yield* Deferred.make<void>()
      let askedPatterns: readonly string[] = []
      const waitTool = yield* StrategyContextWaitTool
      const waitDef = yield* waitTool.init()
      const waitFiber = yield* waitDef
        .execute(
          {},
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "finny",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (request) =>
              Effect.sync(() => {
                askedPatterns = request.patterns
              }).pipe(Effect.andThen(Deferred.succeed(waitStarted, undefined))),
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(waitStarted)
      yield* Deferred.succeed(firstDone, undefined)
      expect((yield* jobs.wait({ id: first.id, timeout: 1_000 })).info?.status).toBe("completed")

      // One completed sibling is not enough to release synthesis. The wait
      // barrier terminalizes the captured set only after every job settles.
      expect((yield* Effect.promise(() => TaskState.get(first.id, database)))?.status).toBe(TaskState.Status.running)
      expect((yield* Effect.promise(() => TaskState.get(second.id, database)))?.status).toBe(TaskState.Status.running)
      const workspace = yield* Effect.promise(() => getSessionWorkspace(chat.id))
      if (!workspace) throw new Error("workspace was not bound")
      const edgeAnalysis = path.join(algoDir(workspace), "edge_analysis.md")
      const blockedWrite = yield* Effect.exit(
        assertFinnyWorkspacePathPolicy(
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "finny",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
          edgeAnalysis,
          "write",
          database,
        ),
      )
      expect(Exit.isFailure(blockedWrite)).toBe(true)

      yield* Deferred.succeed(secondDone, undefined)
      const waited = yield* Fiber.join(waitFiber)
      expect(waited.metadata).toMatchObject({ captured: 2, completed: 2, pendingContext: [] })
      expect(new Set(askedPatterns)).toEqual(new Set(["data_extractor", "news_agent"]))
      const orderedIDs = captured.map((task) => task.id)
      const firstCaptured = orderedIDs[0]
      const secondCaptured = orderedIDs[1]
      if (!firstCaptured || !secondCaptured) throw new Error("expected two captured context tasks")
      expect(waited.output.indexOf(firstCaptured)).toBeLessThan(waited.output.indexOf(secondCaptured))
      expect(yield* Effect.promise(() => StrategyContext.pendingTasks(chat.id, database))).toEqual([])
      yield* assertFinnyWorkspacePathPolicy(
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
        edgeAnalysis,
        "write",
        database,
      )
    }),
  )

  background.instance("consuming context through the wait tool suppresses duplicate automatic delivery", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed("Pinned", "Create a new SPY 1d strategy")
      yield* status.set(chat.id, { type: "busy" })
      let parentDeliveries = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            parentDeliveries += 1
            return Effect.succeed(reply(input, "unexpected duplicate delivery"))
          }
          return Effect.succeed(reply(input, "context complete"))
        },
      }

      const startTool = yield* TaskStartTool
      const startDef = yield* startTool.init()
      const started = yield* startDef.execute(
        {
          description: "research SPY context",
          prompt: "Research SPY market context.",
          subagent_type: "news_agent",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waitTool = yield* StrategyContextWaitTool
      const waitDef = yield* waitTool.init()
      const waited = yield* waitDef.execute(
        {},
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "finny",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(waited.metadata.pendingContext).toEqual([])
      expect(waited.output).toContain(`<context_task id="${started.metadata.sessionId}"`)
      expect((yield* Effect.promise(() => TaskState.get(started.metadata.sessionId, database)))?.status).toBe(
        TaskState.Status.completed,
      )

      yield* status.set(chat.id, { type: "idle" })
      yield* Effect.sleep("250 millis")
      expect(parentDeliveries).toBe(0)
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskStartTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
