import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import PROMPT_RESEARCHER from "../../src/agent/prompt/finny-researcher.txt"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("researcher subagent", () => {
  test("researcher agent is registered as a subagent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Agent.get("researcher")
        expect(info).toBeDefined()
        expect(info!.name).toBe("researcher")
        expect(info!.mode).toBe("subagent")
      },
    })
  })

  test("researcher exposes only its research tool permissions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Agent.get("researcher")
        expect(info).toBeDefined()
        expect(Permission.evaluate("webfetch", "", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("websearch", "", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("finny_discord_read", "", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("read", "algos/_template/data/news/body/btc.md", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/data/news/body/btc.md", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("read", "algos/_template/mission.md", info!.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "algos/_template/mission.md", info!.permission).action).toBe("deny")
        expect(Permission.evaluate("edit", "algos/_template/data/crypto/btc.md", info!.permission).action).toBe("deny")
        expect(Permission.evaluate("read", "algos/live-strategy/data/news/body/btc.md", info!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "", info!.permission).action).toBe("deny")
        expect(Permission.evaluate("finny_algorithm_save", "", info!.permission).action).toBe("deny")
        expect(Permission.evaluate("finny_backtest_run", "", info!.permission).action).toBe("deny")
      },
    })
  })
})

describe("researcher prompt contract", () => {
  test("blocks missing research focus instead of inventing one", () => {
    expect(PROMPT_RESEARCHER).toContain("`BLOCKED: missing research topic`")
    expect(PROMPT_RESEARCHER).toContain("If no topic, symbol, or market focus is present")
  })

  test("requires recency-aware research and source limits", () => {
    expect(PROMPT_RESEARCHER).toContain("last 14 days")
    expect(PROMPT_RESEARCHER).toContain("current-year and recency-aware searches")
    expect(PROMPT_RESEARCHER).toContain("at most five high-signal sources")
    expect(PROMPT_RESEARCHER).toContain("Prefer primary or high-signal sources")
  })

  test("requires cited evidence, implications, and gaps", () => {
    expect(PROMPT_RESEARCHER).toContain("fact with source URL or tool result")
    expect(PROMPT_RESEARCHER).toContain("Strategy Implications")
    expect(PROMPT_RESEARCHER).toContain("Gaps / Caveats")
    expect(PROMPT_RESEARCHER).toContain("no material current context found")
  })

  test("writes durable notes only under template news and treats unavailable sources as gaps", () => {
    expect(PROMPT_RESEARCHER).toContain("algos/_template/data/news/")
    expect(PROMPT_RESEARCHER).toContain("Files written")
    expect(PROMPT_RESEARCHER).toContain("If search or a source is unavailable")
    expect(PROMPT_RESEARCHER).toContain("Gaps / Caveats")
  })

  test("forbids unsupported trading labels and invented citations", () => {
    expect(PROMPT_RESEARCHER).toContain("Do not produce buy/sell labels")
    expect(PROMPT_RESEARCHER).toContain("Do not invent citations")
  })
})
