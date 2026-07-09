import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import PROMPT_SEC_AGENT from "../../src/agent/prompt/finny-sec-agent.txt"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { algosRoot } from "@finny-ai/core/algo"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const agentLayer = Agent.layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(RuntimeFlags.layer()),
)

const it = testEffect(agentLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("sec_agent subagent", () => {
  it.instance("sec_agent is registered as a hidden subagent with prompt", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("sec_agent")
      expect(info).toBeDefined()
      expect(info!.name).toBe("sec_agent")
      expect(info!.mode).toBe("subagent")
      expect(info!.hidden).toBe(true)
      expect(info!.prompt).toContain("SEC EDGAR")
    }),
  )

  it.instance("sec_agent exposes SEC research tools but not strategy/backtest tools", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("sec_agent")
      expect(info).toBeDefined()
      expect(Permission.evaluate("webfetch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("websearch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "", info!.permission).action).toBe("allow")
      const secFile = path.join(algosRoot(), "msft-insider.abc12345", "data", "sec", "MSFT", "sec_manifest.json")
      expect(Permission.evaluate("read", secFile, info!.permission).action).toBe("allow")
      expect(Permission.evaluate("write", secFile, info!.permission).action).toBe("allow")
      expect(Permission.evaluate("read", "algos/_template/README.md", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("read", ".env", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_algorithm_save", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_backtest", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "", info!.permission).action).toBe("deny")
    }),
  )

  it.instance("Build can invoke sec_agent; Research and Chat cannot", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const research = yield* agent.get("research")
      const chat = yield* agent.get("chat")
      expect(Permission.evaluate("task", "sec_agent", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sec_agent", research!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "sec_agent", chat!.permission).action).toBe("deny")
    }),
  )
})

describe("sec_agent prompt contract", () => {
  test("covers SEC EDGAR v1 scope and provenance", () => {
    expect(PROMPT_SEC_AGENT).toContain("SEC EDGAR")
    expect(PROMPT_SEC_AGENT).toContain("Form 3/4/5")
    expect(PROMPT_SEC_AGENT).toContain("13D/13G")
    expect(PROMPT_SEC_AGENT).toContain("Form 13F")
    expect(PROMPT_SEC_AGENT).toContain("allowed_sec_dir")
    expect(PROMPT_SEC_AGENT).toContain("accession")
    expect(PROMPT_SEC_AGENT).toContain("BLOCKED:")
  })

  test("forbids strategy building and legal advice", () => {
    expect(PROMPT_SEC_AGENT).toContain("NOT a strategy builder")
    expect(PROMPT_SEC_AGENT).not.toContain("finny_backtest")
    expect(PROMPT_SEC_AGENT).not.toContain("finny_algorithm_save")
    expect(PROMPT_SEC_AGENT).toContain("legal or compliance advice")
  })

  test("requires structured output sections", () => {
    expect(PROMPT_SEC_AGENT).toContain("## Identity")
    expect(PROMPT_SEC_AGENT).toContain("## Sources checked")
    expect(PROMPT_SEC_AGENT).toContain("## Files written")
    expect(PROMPT_SEC_AGENT).toContain("## Key filings")
    expect(PROMPT_SEC_AGENT).toContain("## Holdings / transaction findings")
    expect(PROMPT_SEC_AGENT).toContain("## Trading relevance")
    expect(PROMPT_SEC_AGENT).toContain("## Gaps / caveats")
  })
})
