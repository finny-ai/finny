import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { TaskTool } from "../../src/tool/task"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

describe("data_extractor subagent", () => {
  it.live("data_extractor agent is registered as a subagent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(info).toBeDefined()
        expect(info.name).toBe("data_extractor")
        expect(info.mode).toBe("subagent")
      }),
    ),
  )

  it.live("data_extractor is not a primary agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(info.mode).not.toBe("primary")
      }),
    ),
  )

  it.live("data_extractor has a prompt defined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(info.prompt).toBeDefined()
        expect(info.prompt!.length).toBeGreaterThan(100)
        expect(info.prompt).toContain("Data Extractor")
      }),
    ),
  )

  it.live("data_extractor has finny_extract_data permission", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        const hasExtractAllow = info.permission.some(
          (r) => r.permission === "finny_extract_data" && r.action === "allow",
        )
        expect(hasExtractAllow).toBe(true)
      }),
    ),
  )

  it.live("data_extractor has steps limit set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(info.steps).toBeDefined()
        expect(info.steps).toBe(10)
      }),
    ),
  )
})

describe("finny_extract_data tool", () => {
  it.live("finny_extract_data is registered in the tool registry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("finny_extract_data")
      }),
    ),
  )

  it.live("finny_extract_data has correct description", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: build,
        })
        const extractTool = tools.find((t) => t.id === "finny_extract_data")
        expect(extractTool).toBeDefined()
        expect(extractTool!.description).toContain("Extract historical OHLCV data")
        expect(extractTool!.description).toContain("parquet")
      }),
    ),
  )
})

describe("data_extractor in task tool description", () => {
  it.live("data_extractor appears in task tool subagent list for build agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: build,
        })
        const taskTool = tools.find((t) => t.id === TaskTool.id)
        expect(taskTool).toBeDefined()
        expect(taskTool!.description).toContain("data_extractor")
        expect(taskTool!.description).toContain("Data extraction subagent")
      }),
    ),
  )

  it.live("data_extractor appears in task tool for research agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const research = yield* agent.get("research")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: research,
        })
        const taskTool = tools.find((t) => t.id === TaskTool.id)
        expect(taskTool).toBeDefined()
        expect(taskTool!.description).toContain("data_extractor")
      }),
    ),
  )

  it.live("data_extractor appears in task tool for chat agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const chat = yield* agent.get("chat")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: chat,
        })
        const taskTool = tools.find((t) => t.id === TaskTool.id)
        expect(taskTool).toBeDefined()
        expect(taskTool!.description).toContain("data_extractor")
      }),
    ),
  )
})

describe("agent list ordering", () => {
  it.live("data_extractor sorts between explore and general", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const all = yield* agent.list()
        const subagents = all.filter((a) => a.mode === "subagent")
        const names = subagents.map((a) => a.name)
        expect(names).toContain("data_extractor")
        expect(names).toContain("explore")
        expect(names).toContain("general")

        const deIdx = names.indexOf("data_extractor")
        const exIdx = names.indexOf("explore")
        const genIdx = names.indexOf("general")
        expect(deIdx).toBeGreaterThan(-1)
        expect(deIdx).toBeLessThan(genIdx)
        expect(exIdx).toBeGreaterThan(deIdx)
        expect(exIdx).toBeLessThan(genIdx)
      }),
    ),
  )
})
