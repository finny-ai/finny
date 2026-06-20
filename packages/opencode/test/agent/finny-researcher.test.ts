import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import PROMPT_NEWS_AGENT from "../../src/agent/prompt/finny-news-agent.txt"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = path.resolve(import.meta.dir, "../../../..")

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

describe("news_agent subagent", () => {
  it.instance("news_agent agent is registered as a subagent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("news_agent")
      expect(info).toBeDefined()
      expect(info!.name).toBe("news_agent")
      expect(info!.mode).toBe("subagent")
    }),
  )

  it.instance("researcher remains as a hidden compatibility alias", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("researcher")
      expect(info).toBeDefined()
      expect(info!.name).toBe("researcher")
      expect(info!.mode).toBe("subagent")
      expect(info!.hidden).toBe(true)
    }),
  )

  it.instance("news_agent exposes only its news tool permissions", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("news_agent")
      expect(info).toBeDefined()
      expect(Permission.evaluate("webfetch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("websearch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("finny_discord_read", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("read", "algos/_template/data/news/body/btc.md", info!.permission).action).toBe(
        "allow",
      )
      expect(Permission.evaluate("edit", "algos/_template/data/news/body/btc.md", info!.permission).action).toBe(
        "allow",
      )
      expect(Permission.evaluate("read", "algos/_template/mission.md", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "algos/_template/mission.md", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "algos/_template/data/crypto/btc.md", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("read", "algos/live-strategy/data/news/body/btc.md", info!.permission).action).toBe(
        "deny",
      )
      expect(Permission.evaluate("bash", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_algorithm_save", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_backtest_run", "", info!.permission).action).toBe("deny")
    }),
  )
})

describe("news_agent prompt contract", () => {
  test("blocks missing news focus instead of inventing one", () => {
    expect(PROMPT_NEWS_AGENT).toContain("`BLOCKED: missing news topic`")
    expect(PROMPT_NEWS_AGENT).toContain("If no topic, symbol, or market focus is present")
  })

  test("requires recency-aware research and source limits", () => {
    expect(PROMPT_NEWS_AGENT).toContain("last 14 days")
    expect(PROMPT_NEWS_AGENT).toContain("current-year and recency-aware searches")
    expect(PROMPT_NEWS_AGENT).toContain("at most three high-signal sources")
    expect(PROMPT_NEWS_AGENT).toContain("Prefer primary or high-signal sources")
  })

  test("requires cited evidence, implications, and gaps", () => {
    expect(PROMPT_NEWS_AGENT).toContain("Current News / Catalysts")
    expect(PROMPT_NEWS_AGENT).toContain("Execution / Market Microstructure")
    expect(PROMPT_NEWS_AGENT).toContain("Data Provenance / Reproducibility")
    expect(PROMPT_NEWS_AGENT).toContain("Risk Regime")
    expect(PROMPT_NEWS_AGENT).toContain("Strategy Implications")
    expect(PROMPT_NEWS_AGENT).toContain("Gaps / Caveats")
    expect(PROMPT_NEWS_AGENT).toContain("no material current context found")
  })

  test("writes durable notes only under workspace news and treats unavailable sources as gaps", () => {
    expect(PROMPT_NEWS_AGENT).toContain("workspace_news_dir")
    expect(PROMPT_NEWS_AGENT).toContain("do not write durable files")
    expect(PROMPT_NEWS_AGENT).toContain("Files written")
    expect(PROMPT_NEWS_AGENT).toContain("If search or a source is unavailable")
    expect(PROMPT_NEWS_AGENT).toContain("Gaps / Caveats")
  })

  test("forbids unsupported trading labels and invented citations", () => {
    expect(PROMPT_NEWS_AGENT).toContain("Do not produce buy/sell labels")
    expect(PROMPT_NEWS_AGENT).toContain("Do not invent citations")
    expect(PROMPT_NEWS_AGENT).toContain("Do not use promotional language")
  })

  test("prioritizes current news plus prop-firm execution and reproducibility evidence", () => {
    expect(PROMPT_NEWS_AGENT).toContain("prop-firm news and market-context brief")
    expect(PROMPT_NEWS_AGENT).toContain("directly relevant news/catalysts")
    expect(PROMPT_NEWS_AGENT).toContain("data provenance")
    expect(PROMPT_NEWS_AGENT).toContain("slippage/spreads")
    expect(PROMPT_NEWS_AGENT).toContain("fills/liquidity")
    expect(PROMPT_NEWS_AGENT).toContain("reproducible and tradable")
  })

  test("repo-local news_agent override keeps prop-firm validation scope", async () => {
    const override = await fs.readFile(path.join(root, ".opencode/agent/news_agent.md"), "utf8")

    expect(override).toContain("prop-firm news and market-context brief")
    expect(override).toContain("directly relevant current news/catalysts")
    expect(override).toContain("data provenance")
    expect(override).toContain("slippage/spreads")
    expect(override).toContain("workspace_news_dir/body/")
    expect(override).not.toContain("every relevant piece of information")
    expect(override).not.toContain("Headlines file: `headlines/<YYYY-MM-DD>.md`")
  })
})
