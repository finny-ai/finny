import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getSessionWorkspace, setActiveAlgo, ensureAlgoWorkspace, algoDir, parseMission } from "@finny-ai/core/algo"
import {
  bootstrapWorkspace,
  deriveIntent,
  derivePromptSlug,
  deriveResearchWorkspaceName,
  deriveWorkspaceName,
  hasStrategyContinuationIntent,
  isNewsResearchPrompt,
  linkAlgorithmToWorkspace,
  mirrorNewsToWorkspace,
  FinnyWorkspacePlugin,
} from "../../src/plugin/finny-workspace"
import { parseRequestFacts } from "../../src/agent/request-identity"
import { extractDateWindow } from "../../src/agent/finny-workspace-context"

const SPY_PROMPT =
  "Build a new SPY 15-minute mean reversion strategy with $10,000 over 3 months. Keep it clean and validate/backtest it in strict mode."

let sandbox: string
let prevXdg: string | undefined
let prevFinnyHome: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-ws-boot-"))
  prevXdg = process.env.XDG_DATA_HOME
  prevFinnyHome = process.env.FINNY_HOME
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.FINNY_HOME
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  if (prevFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = prevFinnyHome
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("workspace naming", () => {
  test("derives intent from the prompt", () => {
    expect(deriveIntent(SPY_PROMPT)).toBe("mean-reversion")
    expect(deriveIntent("build a BTC momentum bot")).toBe("momentum")
    expect(deriveIntent("what is a sharpe ratio?")).toBeUndefined()
  })

  test("derives a kebab workspace name from request facts", () => {
    const facts = parseRequestFacts(SPY_PROMPT)
    expect(deriveWorkspaceName(facts, "mean-reversion", SPY_PROMPT)).toBe("spy-15m-mean-reversion")
  })

  test("derives a name from the prompt when no symbol is present", () => {
    expect(deriveWorkspaceName({}, "options", "options algo")).toBe("options-algo-strategy")
    expect(derivePromptSlug("what is a sharpe ratio?")).toBe("what-sharpe-ratio")
  })

  test("date window extraction skips earlier actual-coverage dates in continuation prompts", () => {
    expect(
      extractDateWindow(
        "Continue. Data is available from 2026-03-17 onward. Write stock/SPY_5m_2026-03-10_2026-06-10.csv.",
      ),
    ).toEqual({ start: "2026-03-10", end: "2026-06-10" })
  })

  test("date window extraction accepts month-name ranges from subagent prompts", () => {
    expect(
      extractDateWindow("The full backtest window is 3 months: March 13, 2026 to June 13, 2026."),
    ).toEqual({ start: "2026-03-13", end: "2026-06-13" })
    expect(extractDateWindow("Backtest Mar 13, 2026 – Jun 13, 2026 for SPY.")).toEqual({
      start: "2026-03-13",
      end: "2026-06-13",
    })
  })

  test("research routing helpers detect news/search vs continuation", () => {
    expect(isNewsResearchPrompt("Search the latest on SpaceX Starlink IPO plans")).toBe(true)
    expect(hasStrategyContinuationIntent("continue where you left off and tighten stops")).toBe(true)
    expect(deriveResearchWorkspaceName("Search SpaceX Starlink IPO status")).toMatch(/-research$/)
  })
})

describe("bootstrapWorkspace (the prompt-in startup routine)", () => {
  test("SPY build prompt provisions a workspace, binds the session, writes request.json", async () => {
    const result = await bootstrapWorkspace("ses_spy1", SPY_PROMPT)
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
    expect(result!.created).toBe(true)

    expect(await getSessionWorkspace("ses_spy1")).toBe(result!.slug)

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("SPY")
    expect(request.requested_interval).toBe("15m")
    expect(request.requested_asset_class).toBe("equity")
    expect(request.request_id).toBe("ses_spy1")

    const mission = parseMission(await fs.readFile(path.join(result!.dir, "mission.md"), "utf8"))
    expect(mission.frontmatter.scope.universe).toEqual(["SPY"])
    expect(mission.frontmatter.scope.asset_class).toBe("equities")
    expect(mission.frontmatter.scope.horizon).toBe("intraday")
    expect(mission.frontmatter.hypothesis).toContain("SPY 15m")
  })

  test("compact strategy slug provisions and binds a workspace", async () => {
    const result = await bootstrapWorkspace("ses_spy_slug", "spy-5m-momentum")
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("spy-5m-momentum.")).toBe(true)
    expect(await getSessionWorkspace("ses_spy_slug")).toBe(result!.slug)

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("SPY")
    expect(request.requested_interval).toBe("5m")
    expect(request.requested_asset_class).toBe("equity")
  })

  test("conceptual build prompt still provisions a workspace", async () => {
    const result = await bootstrapWorkspace("ses_concept", "what is a sharpe ratio and why does it matter?")
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("what-sharpe-ratio-strategy.")).toBe(true)
    expect(await getSessionWorkspace("ses_concept")).toBe(result!.slug)
  })

  test("options algo prompt provisions a workspace", async () => {
    const result = await bootstrapWorkspace("ses_options", "options algo")
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("options-algo-strategy.")).toBe(true)
    expect(await getSessionWorkspace("ses_options")).toBe(result!.slug)
  })

  test("second prompt in the same session reuses the binding", async () => {
    const first = await bootstrapWorkspace("ses_same", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_same", "tighten the SPY 15-minute mean reversion stops")
    expect(second!.slug).toBe(first!.slug)
    expect(second!.created).toBe(false)
    expect(second!.rebound).toBe(false)
  })

  test("continue prompt reuses the session binding", async () => {
    const first = await bootstrapWorkspace("ses_continue", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_continue", "continue where you left off")
    expect(second!.slug).toBe(first!.slug)
    expect(second!.created).toBe(false)
    expect(second!.rebound).toBe(false)
  })

  test("generic strategy follow-ups stay in the existing strategy workspace", async () => {
    const first = await bootstrapWorkspace("ses_strategy_followup", SPY_PROMPT)

    for (const prompt of ["tell me about the strategy", "tell me about the SPY strategy"]) {
      const followup = await bootstrapWorkspace("ses_strategy_followup", prompt)
      expect(followup!.slug).toBe(first!.slug)
      expect(followup!.created).toBe(false)
      expect(followup!.rebound).toBe(false)
    }
  })

  test("explicit news requests still isolate research when they mention the strategy", async () => {
    const first = await bootstrapWorkspace("ses_strategy_news", SPY_PROMPT)
    const second = await bootstrapWorkspace(
      "ses_strategy_news",
      "tell me the latest news affecting the SPY strategy",
    )
    expect(second!.slug).not.toBe(first!.slug)
    expect(second!.slug).toContain("-research.")
    expect(second!.rebound).toBe(true)

    const resumed = await bootstrapWorkspace("ses_strategy_news", "continue and backtest it")
    expect(resumed!.slug).toBe(first!.slug)
    expect(resumed!.rebound).toBe(true)
    expect(await getSessionWorkspace("ses_strategy_news")).toBe(first!.slug)
  })

  test("news/search prompt after a strategy workspace gets an isolated research workspace", async () => {
    const first = await bootstrapWorkspace("ses_research", SPY_PROMPT)
    const second = await bootstrapWorkspace(
      "ses_research",
      "Search the latest on SpaceX Starlink IPO plans and summarize what matters",
    )
    expect(second!.slug).not.toBe(first!.slug)
    expect(second!.slug.startsWith("spacex-starlink-ipo-research.")).toBe(true)
    expect(second!.rebound).toBe(true)
    expect(await getSessionWorkspace("ses_research")).toBe(second!.slug)
  })

  test("existing binding refreshes request context and placeholder mission before subagents run", async () => {
    const first = await bootstrapWorkspace("ses_same_dates", SPY_PROMPT)
    const second = await bootstrapWorkspace(
      "ses_same_dates",
      "Extract SPY 15-minute data from 2026-05-10 to 2026-06-10 for the strategy.",
    )
    expect(second!.slug).toBe(first!.slug)

    const request = JSON.parse(await fs.readFile(path.join(first!.dir, "request.json"), "utf8"))
    expect(request.requested_start).toBe("2026-05-10")
    expect(request.requested_end).toBe("2026-06-10")

    const missionRaw = await fs.readFile(path.join(first!.dir, "mission.md"), "utf8")
    expect(missionRaw).toContain("requested_start: 2026-05-10")
    expect(missionRaw).toContain("requested_end: 2026-06-10")
    expect(missionRaw).not.toContain("- pending")
  })

  test("continuation prompt does not reverse requested dates with actual coverage dates", async () => {
    const first = await bootstrapWorkspace(
      "ses_cont_dates",
      "Extract SPY 5-minute data from 2026-03-10 to 2026-06-10.",
    )
    await bootstrapWorkspace(
      "ses_cont_dates",
      "Continue where you left off. You confirmed SPY 5m data is available from 2026-03-17 onward via yfinance. Write `stock/SPY_5m_2026-03-10_2026-06-10.csv`.",
    )

    const request = JSON.parse(await fs.readFile(path.join(first!.dir, "request.json"), "utf8"))
    expect(request.requested_start).toBe("2026-03-10")
    expect(request.requested_end).toBe("2026-06-10")
  })

  test("conflicting symbol in the same session rebinds to a fresh workspace", async () => {
    const first = await bootstrapWorkspace("ses_pivot", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_pivot", "now build a BTC 5-minute momentum strategy")
    expect(second!.slug).not.toBe(first!.slug)
    expect(second!.slug.startsWith("btc-5m-momentum.")).toBe(true)
    expect(second!.rebound).toBe(true)
    expect(await getSessionWorkspace("ses_pivot")).toBe(second!.slug)
  })
})

describe("bootstrapWorkspace leak regression", () => {
  test("ignores a stale global active-algo marker pointing at another algo", async () => {
    // Recreate the real incident: the machine-global marker points at the BTC
    // workspace from a previous session; a SPY request must NOT land there.
    const btc = await ensureAlgoWorkspace("btc-usdt-5m-momentum")
    await setActiveAlgo(btc.slug)

    const resolved = await bootstrapWorkspace("ses_leak_regress", SPY_PROMPT)

    expect(resolved!.slug).not.toBe(btc.slug)
    expect(resolved!.slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
    // and the fresh workspace is now bound for consistency
    expect(await getSessionWorkspace("ses_leak_regress")).toBe(resolved!.slug)
  })

  test("uses the session-bound workspace when it matches the request", async () => {
    const boot = await bootstrapWorkspace("ses_match", SPY_PROMPT)
    const resolved = await bootstrapWorkspace("ses_match", SPY_PROMPT)
    expect(resolved!.slug).toBe(boot!.slug)
    expect(resolved!.created).toBe(false)
  })

  test("ignores a session binding whose slug conflicts with the requested symbol", async () => {
    const btc = await bootstrapWorkspace("ses_conflict", "build a BTC 5-minute momentum strategy")
    const resolved = await bootstrapWorkspace("ses_conflict", SPY_PROMPT)
    expect(resolved!.slug).not.toBe(btc!.slug)
    expect(resolved!.slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
  })

  test("derives the workspace from request facts instead of an agent-invented storage route", async () => {
    const resolved = await bootstrapWorkspace(
      "ses_storage_route",
      "Build my-existing-algo for SPY 15-minute mean reversion",
    )
    expect(resolved!.slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
  })
})

describe("FinnyWorkspacePlugin hooks", () => {
  test("does not bootstrap workspaces from assistant chat.message output", async () => {
    const hooks = await FinnyWorkspacePlugin({} as any)
    expect(hooks["chat.message"]).toBeUndefined()
  })
})

describe("session consolidation", () => {
  test("saved algorithms are linked into the workspace with a manifest", async () => {
    const boot = await bootstrapWorkspace("ses_consol", SPY_PROMPT)
    const link = await linkAlgorithmToWorkspace("ses_consol", {
      algorithmId: "aaaa-bbbb",
      name: "spy-15m-mean-reversion",
      version: 3,
    })
    expect(link).toBe(path.join(boot!.dir, "algorithms", "spy-15m-mean-reversion"))
    const target = await fs.readlink(link!)
    expect(target.endsWith(path.join("algorithms", "aaaa-bbbb"))).toBe(true)

    const manifest = JSON.parse(await fs.readFile(path.join(boot!.dir, "manifest.json"), "utf8"))
    expect(manifest.algorithms).toHaveLength(1)
    expect(manifest.algorithms[0]).toMatchObject({
      name: "spy-15m-mean-reversion",
      algorithmId: "aaaa-bbbb",
      latest_version: 3,
    })
  })

  test("saved algorithm links point at the FINNY_HOME algorithm store", async () => {
    const home = path.join(sandbox, "custom-home")
    process.env.FINNY_HOME = home
    const boot = await bootstrapWorkspace("ses_custom_home", SPY_PROMPT)
    const link = await linkAlgorithmToWorkspace("ses_custom_home", {
      algorithmId: "home-store-id",
      name: "spy-custom-home",
      version: 1,
    })
    expect(link).toBe(path.join(boot!.dir, "algorithms", "spy-custom-home"))
    expect(await fs.readlink(link!)).toBe(path.join(home, "algorithms", "home-store-id"))
  })

  test("re-saving the same algorithm updates the manifest entry, no duplicate", async () => {
    const boot = await bootstrapWorkspace("ses_consol2", SPY_PROMPT)
    await linkAlgorithmToWorkspace("ses_consol2", { algorithmId: "id-1", name: "spy-x", version: 1 })
    await linkAlgorithmToWorkspace("ses_consol2", { algorithmId: "id-1", name: "spy-x", version: 2 })
    const manifest = JSON.parse(await fs.readFile(path.join(boot!.dir, "manifest.json"), "utf8"))
    expect(manifest.algorithms).toHaveLength(1)
    expect(manifest.algorithms[0].latest_version).toBe(2)
  })

  test("unbound session does not link", async () => {
    expect(await linkAlgorithmToWorkspace("ses_nobind", { algorithmId: "x", name: "y", version: 1 })).toBeUndefined()
  })

  test("research notes written to a repo-local algos dir are mirrored into the workspace", async () => {
    const boot = await bootstrapWorkspace("ses_news", SPY_PROMPT)
    const repoNews = path.join(sandbox, "repo", "algos", "spy-15m-mean-reversion", "data", "news")
    await fs.mkdir(repoNews, { recursive: true })
    const src = path.join(repoNews, "intraday-reversal-rate-spikes.md")
    await fs.writeFile(src, "# reversal data\n", "utf8")

    const dest = await mirrorNewsToWorkspace("ses_news", src)
    expect(dest).toBe(path.join(boot!.dir, "data", "news", "intraday-reversal-rate-spikes.md"))
    expect(await fs.readFile(dest!, "utf8")).toBe("# reversal data\n")
  })

  test("notes already inside the workspace are not re-mirrored", async () => {
    const boot = await bootstrapWorkspace("ses_news2", SPY_PROMPT)
    const inWs = path.join(algoDir(boot!.slug), "data", "news", "note.md")
    await fs.mkdir(path.dirname(inWs), { recursive: true })
    await fs.writeFile(inWs, "x", "utf8")
    expect(await mirrorNewsToWorkspace("ses_news2", inWs)).toBeUndefined()
  })

  test("non-news writes are ignored", async () => {
    await bootstrapWorkspace("ses_news3", SPY_PROMPT)
    expect(await mirrorNewsToWorkspace("ses_news3", "/tmp/whatever/readme.md")).toBeUndefined()
  })
})
