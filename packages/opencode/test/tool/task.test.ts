import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
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
  EMPTY_SUBAGENT_RESULT_MARKER,
  finalTaskText,
  TaskTool,
  type TaskPromptOps,
} from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
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
      Database.defaultLayer,
      RuntimeFlags.layer(flags),
    ).pipe(Layer.provide(Ripgrep.defaultLayer)),
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
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
  return { chat, assistant }
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

  it.live("injects authoritative workspace context for data_extractor tasks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-strategy.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "SPY data extraction",
              prompt:
                "Extract 5-minute OHLCV data for SPY from 2026-03-10 to 2026-06-10. Read algos/_template/README.md first.",
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
          expect(text).toContain("<finny-subagent-context>")
          expect(text).toContain("Data request context:")
          expect(text).toContain("- workspace_slug: spy-5m-strategy.1.1.00.00")
          expect(text).toContain("- requested_algorithm_name: spy-5m-strategy")
          expect(text).not.toContain("- algorithm: spy-5m-strategy.1.1.00.00")
          expect(text).toContain("- symbols or universe: SPY")
          expect(text).toContain("- interval: 5m")
          expect(text).toContain("- start date as absolute YYYY-MM-DD: 2026-03-10")
          expect(text).toContain("- end date as absolute YYYY-MM-DD: 2026-06-10")
          expect(text).toContain(`- allowed_data_dir when known: ${path.join(algoDir(slug), "data")}`)
          expect(text).toContain("Do not read `algos/_template/README.md`")
          expect(text).toContain("requested_start/requested_end")
          expect(text).toContain("actual_start/actual_end")

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
          const yesterday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))
          yesterday.setUTCDate(yesterday.getUTCDate() - 1)
          const yesterdayIso = yesterday.toISOString().slice(0, 10)

          const tool = yield* TaskTool
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
          expect(text).toContain(`- end date as absolute YYYY-MM-DD: ${yesterdayIso}`)
          expect(text).toContain("window_adjustment: intraday rolling window capped")
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

          const tool = yield* TaskTool
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

          const tool = yield* TaskTool
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

          const tool = yield* TaskTool
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

  it.live("passes requested algorithm name separately from workspace slug", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const prev = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = dir
        try {
          const { chat, assistant } = yield* seed()
          const slug = "spy-5m-strategy.1.1.00.00"
          yield* Effect.promise(() => bindSessionWorkspace(chat.id, slug))

          const tool = yield* TaskTool
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
          expect(text).toContain("- workspace_slug: spy-5m-strategy.1.1.00.00")
          expect(text).toContain("- requested_algorithm_name: spy-5m-product-demo-20260614-v2")
          expect(text).not.toContain("- algorithm: spy-5m-strategy.1.1.00.00")
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

          const tool = yield* TaskTool
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
          expect(text).toContain(`- workspace_slug: ${slug}`)
          expect(text).toContain("- requested_algorithm_name: spy-1h-momentum-breakout")
          expect(text).not.toContain("- requested_algorithm_name: p500-1hr-trade-1h-strategy")
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

          const tool = yield* TaskTool
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
          expect(text).toContain("- symbols or universe: SPY")
          expect(text).toContain("- interval: 5m")
          expect(text).toContain("- start date as absolute YYYY-MM-DD: 2026-03-10")
          expect(text).toContain("- end date as absolute YYYY-MM-DD: 2026-06-10")
          expect(text).toContain(`- allowed_data_dir when known: ${path.join(algoDir(slug), "data")}`)
          expect(text).not.toContain("- symbols or universe: MISSING")
          expect(text).not.toContain("- interval: MISSING")
          expect(text).not.toContain("- start date as absolute YYYY-MM-DD: MISSING")
          expect(text).not.toContain("- end date as absolute YYYY-MM-DD: MISSING")
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

          const tool = yield* TaskTool
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
          const promptOps = stubOps({ onPrompt: (input) => seenAgents.push(input.agent ?? "") })
          const tool = yield* TaskTool
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
              metadata: () => Effect.void,
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
            text: (input) =>
              input.agent === "data_extractor" ? dataText : "no material current context found",
          })
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              tasks: [
                {
                  description: "Extract SPY data",
                  prompt:
                    "Extract SPY equity 15m data from 2026-03-23 to 2026-06-17. Name it spy-batch-success.",
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
          expect(result.output).toContain("no material current context found")
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

          const tool = yield* TaskTool
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
          expect(text).toContain("at most one compact news/execution/provenance/risk markdown note")
          expect(text).toContain("Do not write to `algos/_template/data/news`")
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

          const tool = yield* TaskTool
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
          expect(text).toContain("Social sentiment request context:")
          expect(text).toContain("- requested_symbol: AAPL")
          expect(text).toContain("- requested_interval: 1d")
          expect(text).toContain("- requested_asset_class: equity")
          expect(text).toContain("- date window start as absolute YYYY-MM-DD: 2026-06-01")
          expect(text).toContain("- date window end as absolute YYYY-MM-DD: 2026-06-29")
          expect(text).toContain(`- allowed_sentiment_dir: ${path.join(algoDir(slug), "data", "sentiment")}`)
          expect(text).toContain(
            `- expected_sentiment_csv_path: ${path.join(algoDir(slug), "data", "sentiment", "AAPL_2026-06-01_2026-06-29_sentiment.csv")}`,
          )
          expect(text).toContain(
            `- expected_sentiment_manifest_path: ${path.join(algoDir(slug), "data", "sentiment", "AAPL_2026-06-01_2026-06-29_sentiment.manifest.json")}`,
          )
          expect(text).toContain("directly under `allowed_sentiment_dir`")
          expect(text).toContain("Do not use alternate names")
          expect(text).toContain("must not be persisted")
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

          const tool = yield* TaskTool
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
          expect(text).toContain("SEC EDGAR request context:")
          expect(text).toContain("- workspace_slug: msft-insider.1.1.00.00")
          expect(text).toContain("- requested_person: Bill Gates")
          expect(text).toContain("- date window start as YYYY-MM-DD: 2024-01-01")
          expect(text).toContain("- date window end as YYYY-MM-DD: 2024-03-31")
          expect(text).toContain(`- allowed_sec_dir: ${path.join(algoDir(slug), "data", "sec")}`)
          expect(text).toContain("Return `BLOCKED:` when company/person/date scope cannot be resolved")
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

          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            {
              description: "MSFT daily data",
              prompt: "Extract MSFT 1d equity data for a mean reversion strategy.",
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

          const childSession = seen?.sessionID
          expect(childSession).toBeDefined()
          const parentWorkspace = yield* Effect.promise(() => getSessionWorkspace(chat.id))
          const childWorkspace = yield* Effect.promise(() => getSessionWorkspace(childSession!))
          expect(parentWorkspace).not.toBeNull()
          expect(parentWorkspace).toContain("msft-1d-mean-reversion")
          expect(childWorkspace).toBe(parentWorkspace)

          const text = seen?.parts.find((part) => part.type === "text")?.text ?? ""
          expect(text).toContain("- symbols or universe: MSFT")
          expect(text).toContain("- interval: 1d")
          expect(text).toContain(`- allowed_data_dir when known: ${path.join(algoDir(parentWorkspace!), "data")}`)
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
      const tool = yield* TaskTool
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
      const tool = yield* TaskTool
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
      const tool = yield* TaskTool
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
      const tool = yield* TaskTool
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
        const tool = yield* TaskTool
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

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
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
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
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
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
      const tool = yield* TaskTool
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
          background: true,
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
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = defer<SessionPrompt.PromptInput>()
      let parentAttempts = 0

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
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
