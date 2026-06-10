import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
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

  it.live("data_extractor can write only under template data", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(Permission.evaluate("read", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/data/news/body/btc.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/README.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/live-strategy/data/crypto/btc.md", info.permission).action).toBe("deny")
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

describe("data_extractor prompt contract", () => {
  test("blocks instead of silently assuming missing required inputs", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("`symbol` and `interval` are required")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: missing symbol`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: missing interval`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("make the narrowest reasonable assumption")
  })

  test("uses explicit date defaults", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("intervals under 1 hour: last 30 calendar days")
    expect(PROMPT_DATA_EXTRACTOR).toContain("hourly or multi-hour intervals: last 6 months")
    expect(PROMPT_DATA_EXTRACTOR).toContain("daily or higher intervals: last 2 years")
    expect(PROMPT_DATA_EXTRACTOR).toContain("ending on the current run date")
  })

  test("an explicit duration/range overrides the intraday 30-day default", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("use that FULL")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never cap an intraday request to 30 days")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Only when NO range or duration is given")
  })

  test("reports actual tool source instead of a fixed provider order", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("actual selected source")
    expect(PROMPT_DATA_EXTRACTOR).toContain("selected data source and tool digest")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not claim a fixed source order")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("Expected order is Alpaca")
  })

  test("requires digest quality, regime, and suggestions", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("quality notes")
    expect(PROMPT_DATA_EXTRACTOR).toContain("regime summary")
    expect(PROMPT_DATA_EXTRACTOR).toContain("suggestions from the digest")
  })

  test("can persist compact notes under template data only", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("algos/_template/data/")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Only write inside `algos/_template/data/`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Return any written path")
  })
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

  it.live("data_extractor is hidden from chat agent task tool", () =>
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
        expect(taskTool!.description).not.toContain("data_extractor")
        expect(taskTool!.description).toContain("researcher")
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
