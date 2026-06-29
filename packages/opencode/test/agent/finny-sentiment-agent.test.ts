import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"
import PROMPT_SENTIMENT_AGENT from "../../src/agent/prompt/finny-sentiment-agent.txt"
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

describe("sentiment_agent subagent", () => {
  it.instance("sentiment_agent is registered as a hidden subagent with prompt", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("sentiment_agent")
      expect(info).toBeDefined()
      expect(info!.name).toBe("sentiment_agent")
      expect(info!.mode).toBe("subagent")
      expect(info!.hidden).toBe(true)
      expect(info!.prompt).toContain("Social Sentiment Agent")
    }),
  )

  it.instance("sentiment_agent exposes sentiment tools but not strategy/backtest tools", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.get("sentiment_agent")
      expect(info).toBeDefined()
      expect(Permission.evaluate("webfetch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("websearch", "", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "", info!.permission).action).toBe("allow")
      const sentimentFile = path.join(
        algosRoot(),
        "aapl-sentiment.abc12345",
        "data",
        "sentiment",
        "body",
        "AAPL_2026-06-01_2026-06-29_sentiment.csv",
      )
      const headlineFile = path.join(
        algosRoot(),
        "aapl-sentiment.abc12345",
        "data",
        "sentiment",
        "headlines",
        "AAPL.md",
      )
      expect(Permission.evaluate("read", sentimentFile, info!.permission).action).toBe("allow")
      expect(Permission.evaluate("write", sentimentFile, info!.permission).action).toBe("allow")
      expect(Permission.evaluate("write", headlineFile, info!.permission).action).toBe("deny")
      expect(Permission.evaluate("read", "algos/_template/mission.md", info!.permission).action).toBe("allow")
      expect(Permission.evaluate("read", "algos/_template/README.md", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("read", ".env", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_algorithm_save", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_backtest_run", "", info!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "", info!.permission).action).toBe("deny")
    }),
  )

  it.instance("Build can invoke sentiment_agent; Research and Chat cannot", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const research = yield* agent.get("research")
      const chat = yield* agent.get("chat")
      expect(Permission.evaluate("task", "sentiment_agent", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sentiment_agent", research!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "sentiment_agent", chat!.permission).action).toBe("deny")
    }),
  )
})

describe("sentiment_agent prompt contract", () => {
  test("build prompt treats sentiment artifacts as parent-only evidence", () => {
    expect(PROMPT_BUILD).toContain("Sentiment artifacts are build-time evidence")
    expect(PROMPT_BUILD).toContain("Generated strategy code must not read sentiment CSV/manifest files")
    expect(PROMPT_BUILD).toContain("`open()`")
    expect(PROMPT_BUILD).toContain("read CSV/JSON/manifest artifacts")
    expect(PROMPT_BUILD).toContain("daily/swing = trailing 6 months")
    expect(PROMPT_BUILD).toContain("A first data_extractor launch with `start date ... MISSING`")
  })

  test("covers v1 sources and aggregate-only storage", () => {
    expect(PROMPT_SENTIMENT_AGENT).toContain("StockTwits")
    expect(PROMPT_SENTIMENT_AGENT).toContain("ApeWisdom")
    expect(PROMPT_SENTIMENT_AGENT).toContain("Arctic Shift")
    expect(PROMPT_SENTIMENT_AGENT).toContain("PullPush")
    expect(PROMPT_SENTIMENT_AGENT).toContain("allowed_sentiment_dir/body/")
    expect(PROMPT_SENTIMENT_AGENT).toContain("data/sentiment/headlines")
  })

  test("forbids raw text persistence and trading labels", () => {
    expect(PROMPT_SENTIMENT_AGENT).toContain("must not persist raw post bodies")
    expect(PROMPT_SENTIMENT_AGENT).toContain("raw_text_persisted: false")
    expect(PROMPT_SENTIMENT_AGENT).toContain('string `"yes"` or `"no"`')
    expect(PROMPT_SENTIMENT_AGENT).toContain("do not write JSON booleans")
    expect(PROMPT_SENTIMENT_AGENT).toContain("Do not produce buy/sell labels")
    expect(PROMPT_SENTIMENT_AGENT).toContain("no material social sentiment found")
  })

  test("requires structured brief and artifact columns", () => {
    expect(PROMPT_SENTIMENT_AGENT).toContain("## Sentiment Agent Brief")
    expect(PROMPT_SENTIMENT_AGENT).toContain("### Aggregate Signal")
    expect(PROMPT_SENTIMENT_AGENT).toContain("### Source Attempts")
    expect(PROMPT_SENTIMENT_AGENT).toContain("<SYMBOL>_<START>_<END>_sentiment.csv")
    expect(PROMPT_SENTIMENT_AGENT).toContain("<SYMBOL>_<START>_<END>_sentiment.manifest.json")
    expect(PROMPT_SENTIMENT_AGENT).toContain("expected_sentiment_csv_path")
    expect(PROMPT_SENTIMENT_AGENT).toContain("Do not use")
    expect(PROMPT_SENTIMENT_AGENT).toContain("alternate names")
    expect(PROMPT_SENTIMENT_AGENT).toContain("bullish_count,bearish_count")
    expect(PROMPT_SENTIMENT_AGENT).toContain("net_sentiment")
  })

  test("repo-local sentiment_agent override keeps body-only aggregate scope", async () => {
    const override = await fs.readFile(path.join(root, ".opencode/agent/sentiment_agent.md"), "utf8")

    expect(override).toContain("allowed_sentiment_dir/body/")
    expect(override).toContain("expected_sentiment_csv_path")
    expect(override).toContain("<SYMBOL>_<START>_<END>_sentiment.csv")
    expect(override).toContain("StockTwits")
    expect(override).toContain("ApeWisdom")
    expect(override).toContain("raw_text_persisted: false")
    expect(override).toContain('string `"yes"` or `"no"`')
    expect(override).not.toContain("Headlines file")
  })
})
