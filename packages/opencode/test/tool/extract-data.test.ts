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
        expect(info.prompt).toContain("Data Agent")
      }),
    ),
  )

  it.live("data_extractor has data tool permissions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        const hasExtractAllow = info.permission.some(
          (r) => r.permission === "finny_extract_data" && r.action === "allow",
        )
        const hasBashAllow = info.permission.some((r) => r.permission === "bash" && r.action === "allow")
        const hasReadAllow = info.permission.some((r) => r.permission === "read" && r.action === "allow")
        const hasSkillAllow = info.permission.some((r) => r.permission === "skill" && r.action === "allow")
        const hasRemovedDataBashAllow = info.permission.some(
          (r) => r.permission === "finny_data_bash" && r.action === "allow",
        )
        expect(hasExtractAllow).toBe(false)
        expect(hasBashAllow).toBe(true)
        expect(hasReadAllow).toBe(true)
        expect(hasSkillAllow).toBe(true)
        expect(hasRemovedDataBashAllow).toBe(false)
      }),
    ),
  )

  it.live("data_extractor can read source files but not env files or direct edits", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const info = yield* agent.get("data_extractor")
        expect(Permission.evaluate("read", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("read", "/tmp/.env", info.permission).action).toBe("deny")
        expect(Permission.evaluate("read", "/tmp/.env.local", info.permission).action).toBe("deny")
        expect(Permission.evaluate("read", "algos/_template/mission.md", info.permission).action).toBe("allow")
        expect(Permission.evaluate("external_directory", "/tmp/*", info.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "curl https://example.com/data.csv", info.permission).action).toBe("allow")
        expect(Permission.evaluate("skill", "finny-provider-binance", info.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/data/crypto/btc.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/data/news/body/btc.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/mission.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/README.md", info.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/live-strategy/data/crypto/btc.md", info.permission).action).toBe(
          "deny",
        )
      }),
    ),
  )
})

describe("data_extractor prompt contract", () => {
  test("blocks instead of silently assuming missing required inputs", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Data request context")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: incomplete data request")
    expect(PROMPT_DATA_EXTRACTOR).toContain("missing <fields>")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("`BLOCKED: missing symbol`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("`BLOCKED: missing interval`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("`BLOCKED: missing data window`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("make the narrowest reasonable assumption")
  })

  test("does not invent date windows", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not apply default date windows")
    expect(PROMPT_DATA_EXTRACTOR).toContain("absolute `YYYY-MM-DD`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("last 30 calendar days")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("last 6 months")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("last 2 years")
  })

  test("does not let mission files override runtime context", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("runtime-injected context")
    expect(PROMPT_DATA_EXTRACTOR).toContain("never let them override")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("stale")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("mission data context mismatch")
  })

  test("requires authoritative context parsing before source work", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("<finny-subagent-context>")
    expect(PROMPT_DATA_EXTRACTOR).toContain("highest-authority input")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use task prose only to clarify intent")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never rely on memory from another run")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use the interval from runtime context as the canonical requested interval")
  })

  test("reports command source and artifact summary instead of raw rows", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("selected data source and command artifact summary")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Return the tool output without dumping raw rows")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("Expected order is Alpaca")
  })

  test("uses existing bash for enterprise sources", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("`bash`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("exported environment")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`workdir`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("bash write guard")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("`finny_data_bash`")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("{{secret:alias}}")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Return any written data or manifest path")
  })

  test("uses instructions plus bash without legacy extractor fallback", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("data-agent/instructions.md")
    expect(PROMPT_DATA_EXTRACTOR).toContain("source connection cookbook")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Choose the recipe that matches")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Parameterize the recipe")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Select the best matching source recipe")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: missing data-agent instructions`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("removed `finny_extract_data` tool")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("legacy built-in OHLCV fallback")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("A/B evaluation")
  })

  test("limits available tools to read, skill, and bash", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("only tools are `read`, `skill`, and `bash`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never call `glob`, `write`, `edit`")
  })

  test("requires provider skill selection before provider fetches", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Provider-specific skills are available")
    expect(PROMPT_DATA_EXTRACTOR).toContain("call `skill` exactly once for that provider")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-binance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-polygon`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-yfinance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("matching provider skill name")
  })

  test("requires CSV plus manifest and forbids estimated metrics", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("exactly one OHLCV CSV plus one `.manifest.json`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("workspace_slug")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`not_returned`")
  })

  test("plans, verifies, and reports partial coverage honestly", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Form an extraction plan before the first fetch command")
    expect(PROMPT_DATA_EXTRACTOR).toContain("selected source and fallback source")
    expect(PROMPT_DATA_EXTRACTOR).toContain("source-capability preflight")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Before returning, read back the saved CSV and manifest")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Attempt the full requested window first")
    expect(PROMPT_DATA_EXTRACTOR).toContain("do not silently shorten the request")
    expect(PROMPT_DATA_EXTRACTOR).toContain("mark coverage as partial")
    expect(PROMPT_DATA_EXTRACTOR).toContain("source attempts and any fallback reason")
    expect(PROMPT_DATA_EXTRACTOR).toContain("usable_for_parent")
  })

  test("uses correct OHLC validation rule", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("high >= max(open, close)")
    expect(PROMPT_DATA_EXTRACTOR).toContain("low <= min(open, close)")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never use chained comparisons")
  })

  test("fails fast on known public provider intraday limits", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("provider-capability preflight")
    expect(PROMPT_DATA_EXTRACTOR).toContain("do not run repeated doomed retries")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: requested evidence window unavailable`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("usable_for_parent: no")
    expect(PROMPT_DATA_EXTRACTOR).toContain("public yfinance equity/ETF `5min` over `3m`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("try Alpaca first")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not return `BLOCKED: requested evidence window unavailable` based on yfinance limits alone")
  })
})

describe("data-agent instructions contract", () => {
  test("commits source connection recipes for bash data extraction", async () => {
    const instructionsPath = path.resolve(import.meta.dir, "../../../..", "data-agent/instructions.md")
    const instructions = await Bun.file(instructionsPath).text()

    expect(instructions).toContain("main source cookbook")
    expect(instructions).toContain("## Runtime Contract")
    expect(instructions).toContain("Data request context")
    expect(instructions).toContain("allowed_data_dir")
    expect(instructions).toContain("Settings → Brokerages")
    expect(instructions).toContain("## Source Selection")
    expect(instructions).toContain("## Alpaca-First With yfinance Fallback (Equity/ETF)")
    expect(instructions).toContain("## Provider Capability Preflight")
    expect(instructions).toContain("## Artifact Verification")
    expect(instructions).toContain("## yfinance")
    expect(instructions).toContain("## Binance Public Klines")
    expect(instructions).toContain("## Alpaca Market Data")
    expect(instructions).toContain("## Polygon Market Data")
    expect(instructions).toContain("## Oracle Read-Only SQL")
    expect(instructions).toContain("ALPACA_API_KEY_ID")
    expect(instructions).toContain("POLYGON_API_KEY")
    expect(instructions).toContain("${BINANCE_BASE_URL:-https://api.binance.com}/api/v3/klines")
    expect(instructions).toContain("BINANCE_BASE_URL=https://data-api.binance.vision")
    expect(instructions).toContain("https://data.alpaca.markets/v2/stocks/bars")
    expect(instructions).toContain("https://api.polygon.io/v2/aggs/ticker")
    expect(instructions).toContain("yfinance as yf")
    expect(instructions).not.toContain("finny secret set")
    expect(instructions).toContain("manifest")
    expect(instructions).toContain("\"rows\": 252")
    expect(instructions).toContain("high >= max(open, close)")
    expect(instructions).toContain("low <= min(open, close)")
    expect(instructions).not.toContain("high >= low >= close >= open")
    expect(instructions).toContain("FINNY_PYTHON_BIN")
    expect(instructions).toContain("Fetch from Alpaca first")
    expect(instructions).toContain("Polygon aggregate bars")
    expect(instructions).toContain("finny-provider-binance")
    expect(instructions).toContain("finny-provider-polygon")
    expect(instructions).toContain("finny-provider-yfinance")
    expect(instructions).toContain("next_page_token")
    expect(instructions).toContain("next_url")
    expect(instructions).toContain("fall back to yfinance")
    expect(instructions).toContain("when the provider-capability preflight already proves")
    expect(instructions).toContain("do not make repeated doomed")
    expect(instructions).toContain("`5min` over `3m`")
    expect(instructions).toContain("usable_for_parent")
    expect(instructions).toContain("Return the verification summary")
    expect(instructions).not.toContain("command_hash")
    expect(instructions).not.toContain("credential_env_names")
    expect(instructions).not.toContain("finny_extract_data")
    expect(instructions).not.toContain("Legacy Comparison")
  })

  test("commits project-local provider skills for data sources", async () => {
    const skillRoot = path.resolve(import.meta.dir, "../../../..", ".opencode/skills")
    const binance = await Bun.file(path.join(skillRoot, "finny-provider-binance/SKILL.md")).text()
    const polygon = await Bun.file(path.join(skillRoot, "finny-provider-polygon/SKILL.md")).text()
    const yfinance = await Bun.file(path.join(skillRoot, "finny-provider-yfinance/SKILL.md")).text()

    expect(binance).toContain("name: finny-provider-binance")
    expect(binance).toContain("BTC/USD")
    expect(binance).toContain("limit=1000")
    expect(binance).toContain("next startTime")
    expect(binance).toContain('source: "binance"')

    expect(polygon).toContain("name: finny-provider-polygon")
    expect(polygon).toContain("POLYGON_API_KEY")
    expect(polygon).toContain("https://api.polygon.io/v2/aggs/ticker")
    expect(polygon).toContain("adjusted=true")
    expect(polygon).toContain("entitlement/plan limit")

    expect(yfinance).toContain("name: finny-provider-yfinance")
    expect(yfinance).toContain("FINNY_PYTHON_BIN")
    expect(yfinance).toContain("Yahoo v8 chart HTTP API")
    expect(yfinance).toContain("provider-limit")
  })

  test("commits an env template without concrete secret values", async () => {
    const examplePath = path.resolve(import.meta.dir, "../../../..", ".env.example")
    const example = await Bun.file(examplePath).text()

    expect(example).toContain("Copy this file to `.env`")
    expect(example).toContain("MARKET_DATA_URL=")
    expect(example).toContain("POLYGON_API_KEY=")
    expect(example).toContain("ALPACA_API_KEY_ID=")
    expect(example).toContain("ALPACA_API_SECRET_KEY=")
    expect(example).toContain("ORACLE_DSN=")
    expect(example).toContain("BLOOMBERG_API_KEY=")
    expect(example).not.toContain("sk_live_")
    expect(example).not.toContain("password123")
  })
})

describe("data extractor migration", () => {
  it.live("does not register finny_extract_data", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("finny_extract_data")
      }),
    ),
  )
})

describe("data bash simplification", () => {
  it.live("uses existing bash and does not register finny_data_bash", () =>
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
        expect(taskTool?.description ?? "").not.toContain("data_extractor")
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
