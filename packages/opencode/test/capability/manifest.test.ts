import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { Agent } from "../../src/agent/agent"
import { EngineV2 } from "../../src/backtest/results"
import {
  CAPABILITY_MANIFEST_VERSION,
  buildCapabilityManifest,
  capabilityManifestSystemFragment,
} from "../../src/capability/manifest"
import { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool/tool"

function agent(name: string, permission: Record<string, any>, mode: Agent.Info["mode"] = "primary"): Agent.Info {
  return {
    name,
    mode,
    permission: Permission.fromConfig(permission),
    options: {},
  }
}

function tool(id: string, required: string[] = []): Tool.Def {
  return {
    id,
    description: `${id} summary`,
    parameters: Schema.Unknown,
    jsonSchema: {
      type: "object",
      properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
      required,
    },
    execute: () => Effect.succeed({ title: "", output: "", metadata: {} }),
  }
}

const registry = [
  tool("task", ["subagent_type"]),
  tool("finny_backtest", ["algorithmName"]),
  tool("finny_get_history", ["symbol"]),
  tool("finny_algorithm_set_params", ["algorithmName"]),
  tool("finny_backtest_history"),
  tool("finny_nonexistent_provider_skill"),
]

const subagents = [
  agent("data_extractor", {}, "subagent"),
  agent("news_agent", {}, "subagent"),
  agent("researcher", {}, "subagent"),
  agent("unavailable_agent", {}, "subagent"),
]

describe("Finny capability manifest", () => {
  test("advertises lean_python and lean_csharp with the same adapter readiness", () => {
    const finny = agent("finny", {
      "*": "deny",
      finny_backtest: "allow",
    })
    const manifest = buildCapabilityManifest({ agent: finny, agents: subagents, tools: registry })
    const runtimes = manifest.backtest?.runtimes ?? []
    const python = runtimes.find((item) => item.profileId === "lean_python")
    const csharp = runtimes.find((item) => item.profileId === "lean_csharp")
    const qc = runtimes.find((item) => item.profileId === "qc_cloud")
    // Both LEAN runtimes ship through the same pinned adapter and image, so
    // their availability must never diverge.
    expect(python?.availability).toBe(csharp?.availability)
    expect(csharp?.availability).toBeDefined()
    expect(qc?.availability).toBeDefined()
  })

  test("advertises the engine-v2 metrics Gemini previously missed", () => {
    const finny = agent("finny", {
      "*": "deny",
      task: { data_extractor: "allow", news_agent: "allow", researcher: "allow" },
      finny_backtest: "allow",
      finny_get_history: "allow",
    })
    const manifest = buildCapabilityManifest({ agent: finny, agents: subagents, tools: registry })

    expect(manifest.version).toBe(CAPABILITY_MANIFEST_VERSION)
    expect(manifest.phase).toBe("strategy")
    expect(manifest.tools.map((item) => item.id)).toEqual(["finny_backtest", "finny_get_history"])
    expect(manifest.tools[0]?.requiredInputs).toEqual(["algorithmName"])
    expect(manifest.backtest?.engine).toEqual({
      id: "engine_v2",
      schemaMajor: EngineV2.SCHEMA_VERSION_MAJOR,
      executionTiming: "next_bar_open",
    })
    expect(manifest.backtest?.metrics).toEqual(
      expect.arrayContaining([
        "profit_factor",
        "max_gross_exposure",
        "time_in_market",
        "deflated_sharpe_probability",
        "probabilistic_sharpe_ratio",
      ]),
    )
    expect(manifest.backtest?.robustnessTests).toContain("walk_forward")
    expect(manifest.backtest?.benchmarks).toContain("buy_and_hold")
    expect(manifest.backtest?.costs).toEqual(expect.arrayContaining(["fees", "slippage", "funding", "borrow"]))
  })

  test("scopes tools to the active phase and omits denied or nonexistent capabilities", () => {
    const research = agent("research", {
      "*": "deny",
      task: { data_extractor: "allow" },
      finny_get_history: "allow",
      finny_algorithm_set_params: "allow",
      finny_backtest: "allow",
      finny_nonexistent_provider_skill: "allow",
    })
    const manifest = buildCapabilityManifest({
      agent: research,
      agents: subagents,
      tools: registry.filter((item) => item.id !== "finny_nonexistent_provider_skill"),
    })

    expect(manifest.phase).toBe("research")
    // research contracts include set_params; backtest is out of phase and omitted
    expect(manifest.tools.map((item) => item.id)).toEqual(["finny_algorithm_set_params", "finny_get_history"])
    expect(manifest.backtest).toBeUndefined()
    expect(manifest.agents.map((item) => item.id)).toEqual(["data_extractor"])
  })

  test("resolves compatibility aliases before advertising execution IDs", () => {
    const chat = agent("chat", {
      "*": "deny",
      task: { news_agent: "allow", researcher: "allow" },
    })
    const manifest = buildCapabilityManifest({ agent: chat, agents: subagents, tools: registry })
    const canonical = manifest.agents.find((item) => item.id === "news_agent")
    const alias = manifest.agents.find((item) => item.id === "researcher")

    expect(canonical).toMatchObject({ canonicalId: "news_agent", aliases: ["researcher"] })
    expect(alias).toMatchObject({ canonicalId: "news_agent" })
    expect(manifest.selectedCapabilities.filter((item) => item === "agent:news_agent")).toHaveLength(1)
  })

  test("omits researcher alias when only news_agent is permitted", () => {
    // Mirrors finny strategy mode: task allows news_agent but not researcher.
    const finny = agent("finny", {
      "*": "deny",
      task: { news_agent: "allow" },
    })
    const manifest = buildCapabilityManifest({ agent: finny, agents: subagents, tools: registry })
    const news = manifest.agents.find((item) => item.id === "news_agent")
    expect(news).toMatchObject({ canonicalId: "news_agent", aliases: [] })
    expect(manifest.agents.find((item) => item.id === "researcher")).toBeUndefined()
  })

  test("has a deterministic hash and emits one machine-readable system object", () => {
    const build = agent("build", { "*": "deny", finny_backtest: "allow" })
    const first = buildCapabilityManifest({ agent: build, agents: subagents, tools: registry })
    const second = buildCapabilityManifest({
      agent: build,
      agents: [...subagents].reverse(),
      tools: [...registry].reverse(),
    })

    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.hash).toBe(first.hash)
    const fragment = capabilityManifestSystemFragment(first)
    const json = fragment.replace("<finny_capability_manifest>", "").replace("</finny_capability_manifest>", "")
    expect(JSON.parse(json)).toEqual(first)
  })
})
