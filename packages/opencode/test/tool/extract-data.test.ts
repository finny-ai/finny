import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { TaskTool } from "../../src/tool/task"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.suspend(() =>
    Layer.mergeAll(
      Agent.defaultLayer,
      Config.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      Session.defaultLayer,
      Truncate.defaultLayer,
      ToolRegistry.defaultLayer,
    ),
  ),
)

describe("data_extractor subagent", () => {
  it.live("is registered as a compact research subagent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(info).toBeDefined()
        expect(info.name).toBe("data_extractor")
        expect(info.mode).toBe("subagent")
        expect(info.prompt).toBe(PROMPT_DATA_EXTRACTOR)
        expect(info.prompt!.length).toBeLessThan(2_000)
      }),
    ),
  )

  it.live("can research providers and finalize data without mutation or delegation tools", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        for (const tool of ["bash", "read", "websearch", "webfetch", "finny_dataset_evidence_finalize"]) {
          expect(Permission.evaluate(tool, "*", info.permission).action).toBe("allow")
        }
        for (const tool of ["skill", "write", "edit", "task", "finny_backtest", "finny_extract_data", "finny_data_bash"]) {
          expect(Permission.evaluate(tool, "*", info.permission).action).not.toBe("allow")
        }
      }),
    ),
  )

  it.live("keeps repository mutation and secret reads blocked", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(Permission.evaluate("read", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("read", "/tmp/.env", info.permission).action).toBe("deny")
        expect(Permission.evaluate("read", "/tmp/.env.local", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/mission.md", info.permission).action).toBe("deny")
      }),
    ),
  )
})

describe("compact Data Agent guidance", () => {
  test("keeps the prompt behavioral instead of provider-specific", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use your judgment")
    expect(PROMPT_DATA_EXTRACTOR).toContain("official provider documentation")
    expect(PROMPT_DATA_EXTRACTOR).toContain("preserve what you collected")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never expose credentials")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("Return Checklist")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("finny-provider-")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("exactly once")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("requested_algorithm_name:")
  })

  test("keeps instructions short and source-agnostic", async () => {
    const instructionsPath = path.resolve(import.meta.dir, "../../../..", "data-agent/instructions.md")
    const instructions = await Bun.file(instructionsPath).text()
    expect(instructions.length).toBeLessThan(2_000)
    expect(instructions).toContain("official APIs")
    expect(instructions).toContain("timestamp,open,high,low,close,volume")
    expect(instructions).toContain("fill missing ranges")
    expect(instructions).not.toContain("https://")
    expect(instructions).not.toContain("finny-provider-")
    expect(instructions).not.toContain("ALPACA_API_KEY_ID")
    expect(instructions).not.toContain("POLYGON_API_KEY")
  })

  it.live("finalizer supports iterative coverage repair", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agent = yield* Agent.Service
        const selected = yield* agent.get("data_extractor")
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: selected,
        })
        const finalizer = tools.find((tool) => tool.id === "finny_dataset_evidence_finalize")
        expect(finalizer).toBeDefined()
        expect(finalizer!.description).toContain("may call this again")
        expect(finalizer!.description).not.toContain("Call this once")
      }),
    ),
  )
})

describe("data tool surface", () => {
  it.live("does not register removed extractor tools", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("bash")
        expect(ids).not.toContain("finny_data_bash")
        expect(ids).not.toContain("finny_extract_data")
      }),
    ),
  )

  it.live("advertises data_extractor only where it is available", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        for (const name of ["build", "research"] as const) {
          const selected = yield* agent.get(name)
          const tools = yield* registry.tools({ providerID: "test" as any, modelID: "test-model" as any, agent: selected })
          expect(tools.find((tool) => tool.id === TaskTool.id)?.description).toContain("data_extractor")
        }
        const chat = yield* agent.get("chat")
        const chatTools = yield* registry.tools({ providerID: "test" as any, modelID: "test-model" as any, agent: chat })
        expect(chatTools.find((tool) => tool.id === TaskTool.id)?.description ?? "").not.toContain("data_extractor")
      }),
    ),
  )

  it.live("keeps stable subagent ordering", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const names = (yield* agent.list()).filter((item) => item.mode === "subagent").map((item) => item.name)
        expect(names.indexOf("data_extractor")).toBeLessThan(names.indexOf("explore"))
        expect(names.indexOf("explore")).toBeLessThan(names.indexOf("general"))
      }),
    ),
  )
})
