import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  getSessionWorkspace,
  setActiveAlgo,
  ensureAlgoWorkspace,
  algoDir,
  parseMission,
  bindSessionWorkspace,
} from "@finny-ai/core/algo"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
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
import { parseRequestFacts, verifyIdentity } from "../../src/agent/request-identity"
import {
  extractDateWindow,
  syncWorkspaceRequestContext,
  writeWorkflowRequestProjection,
} from "../../src/agent/finny-workspace-context"
import { createBuildWorkflow } from "../../src/algorithm/build-workflow/state"
import { readRequestSpec } from "../../src/agent/request-spec"

const SPY_PROMPT =
  "Build a new SPY 15-minute mean reversion strategy with $10,000 over 3 months. Keep it clean and validate/backtest it in strict mode."
const SMH_EDGE_PROMPT =
  "I am market-aware and I want to test a stronger edge than broad SPY daily mean reversion. Use SMH as the traded symbol. Prefer 1h or 4h bars with semiconductor/AI leadership momentum."

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
    expect(deriveIntent(SMH_EDGE_PROMPT)).toBe("momentum")
    expect(deriveIntent("what is a sharpe ratio?")).toBeUndefined()
  })

  test("derives a kebab workspace name from request facts", () => {
    const facts = parseRequestFacts(SPY_PROMPT)
    expect(deriveWorkspaceName(facts, "mean-reversion", SPY_PROMPT)).toBe("spy-15m-mean-reversion")
    const smhFacts = parseRequestFacts(SMH_EDGE_PROMPT)
    expect(deriveWorkspaceName(smhFacts, deriveIntent(SMH_EDGE_PROMPT), SMH_EDGE_PROMPT)).toBe("smh-1h-momentum")
  })

  test("derives a basket workspace name from an explicit universe", () => {
    const facts = parseRequestFacts("requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities")
    expect(deriveWorkspaceName(facts, "swing", "Trump-linked stocks")).toBe("djt-rum-geo-cxw-1d-swing")
  })

  test("names a mixed-asset universe after the primary symbol only", () => {
    // Regression: a BTC/USD + AAPL request produced the conflicting
    // "btc-usd-aapl-1d-momentum" name whose embedded AAPL token contradicts
    // the single crypto asset class; the workspace must be named for the
    // primary symbol.
    const facts = parseRequestFacts("research BTC/USD and AAPL with 1d bars")
    expect(deriveWorkspaceName(facts, "momentum", "research BTC/USD and AAPL with 1d bars")).toBe("btc-1d-momentum")
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
    expect(extractDateWindow("The full backtest window is 3 months: March 13, 2026 to June 13, 2026.")).toEqual({
      start: "2026-03-13",
      end: "2026-06-13",
    })
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
  test("keeps the bound primary workspace when a multi-symbol request arrives", async () => {
    // Regression: finny_workspace_prepare with symbols ["BTC/USD", "AAPL"]
    // against an existing btc-algo binding used to derive a fresh
    // "btc-usd-aapl-1d-momentum" workspace and rebind the session, splitting
    // the workflow away from its own evidence directories. The workflow-owned
    // primary workspace must win.
    const first = await bootstrapWorkspace("ses_mixed_primary", "research BTC/USD and AAPL with daily bars")
    expect(first).toBeDefined()
    expect(first!.slug.startsWith("btc-1d-")).toBe(true)

    const second = await bootstrapWorkspace("ses_mixed_primary", "research BTC/USD and AAPL with daily bars", {
      requested_symbol: "BTC/USD",
      requested_symbols: ["BTC/USD", "AAPL"],
      requested_asset_class: "crypto",
      requested_interval: "1d",
    })
    expect(second!.slug).toBe(first!.slug)
    expect(second!.created).toBe(false)
    expect(second!.rebound).toBe(false)
  })

  test("single-symbol identity changes still rebind to a fresh workspace", async () => {
    const first = await bootstrapWorkspace("ses_single_switch", "build a SPY daily strategy")
    const second = await bootstrapWorkspace("ses_single_switch", "build a QQQ daily strategy")
    expect(second!.slug).not.toBe(first!.slug)
    expect(second!.created).toBe(true)
  })

  test("audit prompt keeps daily identity across workspace naming and request context", async () => {
    const prompt = "Build a daily AAPL strategy using a 20-day SMA and test it for leakage."
    const result = await bootstrapWorkspace("ses_issue_131", prompt)

    expect(result).toBeDefined()
    expect(result!.slug.startsWith("aapl-1d-")).toBe(true)
    expect(result!.slug).not.toContain("20d")

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("AAPL")
    expect(request.requested_interval).toBe("1d")
    expect(request.requested_asset_class).toBe("equity")
    expect(
      verifyIdentity(request, {
        actual_symbol: "AAPL",
        actual_interval: "1d",
        actual_asset_class: "equity",
      }).ok,
    ).toBe(true)
  })

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

  test("workflow-owned request projections cannot be overwritten by later prompt context", async () => {
    const result = await bootstrapWorkspace("ses_workflow_projection", SPY_PROMPT)
    const source = { kind: "user_message" as const, messageId: "msg_workflow_projection" }
    const state = createBuildWorkflow({
      workflowId: "wf_projection",
      sessionId: "ses_workflow_projection",
      workspaceSlug: result!.slug,
      intent: "build",
      identity: {
        symbols: { value: ["SPY"], source },
        interval: { value: "15m", source },
        assetClass: { value: "equity", source },
        algorithmName: { value: "spy-15m-mean-reversion", source },
        window: { value: { start: "2026-04-01", end: "2026-07-01" }, source },
      },
      now: 1_000,
    })
    await writeWorkflowRequestProjection(state)

    const context = await syncWorkspaceRequestContext({
      sessionID: "ses_workflow_projection",
      slug: result!.slug,
      prompt: "Switch to QQQ 5-minute momentum from 2025-01-01 to 2026-07-01.",
    })
    expect(context).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "15m",
      requested_start: "2026-04-01",
      requested_end: "2026-07-01",
    })
    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request).toMatchObject({
      source_of_truth: "algorithm_build_workflow",
      workflow_id: "wf_projection",
      requested_symbol: "SPY",
      requested_interval: "15m",
    })
  })

  test("explicit workspace preparation fills missing workflow facts in the runtime request spec", async () => {
    const result = await bootstrapWorkspace("ses_workflow_prepare", "Build a SPY equity strategy.")
    const source = { kind: "user_message" as const, messageId: "msg_workflow_prepare" }
    const state = createBuildWorkflow({
      workflowId: "wf_prepare",
      sessionId: "ses_workflow_prepare",
      workspaceSlug: result!.slug,
      intent: "build",
      identity: {
        symbols: { value: ["SPY"], source },
        assetClass: { value: "equity", source },
        algorithmName: { value: "spy-strategy", source },
      },
      now: 1_000,
    })
    await writeWorkflowRequestProjection(state)

    const context = await syncWorkspaceRequestContext({
      sessionID: "ses_workflow_prepare",
      slug: result!.slug,
      prompt: "symbol SPY; asset class equity; interval 1d; date window 2023-07-01 to 2026-07-13",
      facts: {
        requested_symbol: "SPY",
        requested_asset_class: "equity",
        requested_interval: "1d",
        requested_algorithm_name: "different-name-must-not-pivot",
      },
      recordExplicitRequestContext: true,
      actor: "user",
    })

    expect(context).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_algorithm_name: "spy-strategy",
      requested_start: "2023-07-01",
      requested_end: "2026-07-13",
    })
    expect(await readRequestSpec({ requestID: "ses_workflow_prepare" })).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_algorithm_name: "spy-strategy",
      requested_start: "2023-07-01",
      requested_end: "2026-07-13",
    })

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request).toMatchObject({
      source_of_truth: "algorithm_build_workflow",
      workflow_id: "wf_prepare",
      requested_symbol: "SPY",
      requested_algorithm_name: "spy-strategy",
    })
    expect(request.requested_interval).toBeUndefined()
    expect(request.requested_start).toBeUndefined()
    expect(request.requested_end).toBeUndefined()
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

  test("terse ticker and compact interval preserve the exact request identity", async () => {
    const result = await bootstrapWorkspace("ses_vfv_compact", "VFV 15min")
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("vfv-15m-strategy.")).toBe(true)

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("VFV")
    expect(request.requested_interval).toBe("15m")
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

  test("explicit basket request does not reuse a stale single-symbol workspace", async () => {
    const stale = await ensureAlgoWorkspace("es-1d-momentum")
    await bindSessionWorkspace("ses_stale_es", stale.slug)
    expect(await getSessionWorkspace("ses_stale_es")).toBe(stale.slug)

    const next = await bootstrapWorkspace(
      "ses_stale_es",
      "requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities swing strategy",
    )
    expect(next!.slug).not.toBe(stale.slug)
    expect(next!.slug.startsWith("djt-rum-geo-cxw-1d-swing.")).toBe(true)
    expect(await getSessionWorkspace("ses_stale_es")).toBe(next!.slug)

    const request = JSON.parse(await fs.readFile(path.join(next!.dir, "request.json"), "utf8"))
    expect(request.requested_symbols).toEqual(["DJT", "RUM", "GEO", "CXW"])
    expect(request.requested_symbol).toBeUndefined()
  })

  test("continue prompt reuses the session binding", async () => {
    const first = await bootstrapWorkspace("ses_continue", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_continue", "continue where you left off")
    expect(second!.slug).toBe(first!.slug)
    expect(second!.created).toBe(false)
    expect(second!.rebound).toBe(false)
  })

  test("identity-less follow-ups (unblock actions) reuse the session binding", async () => {
    const first = await bootstrapWorkspace("ses_rerun", SPY_PROMPT)

    for (const prompt of [
      "Re-run with end date 2026-07-01.",
      "try again with 2026-06-30 as the end date",
      "use the other provider and go again",
    ]) {
      const followup = await bootstrapWorkspace("ses_rerun", prompt)
      expect(followup!.slug).toBe(first!.slug)
      expect(followup!.created).toBe(false)
      expect(followup!.rebound).toBe(false)
    }
    expect(await getSessionWorkspace("ses_rerun")).toBe(first!.slug)
  })

  test("identity-less prompts without retry intent reuse the session workspace", async () => {
    const first = await bootstrapWorkspace("ses_concept_after", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_concept_after", "what is a sharpe ratio and why does it matter?")
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
    const second = await bootstrapWorkspace("ses_strategy_news", "tell me the latest news affecting the SPY strategy")
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
    const first = await bootstrapWorkspace("ses_cont_dates", "Extract SPY 5-minute data from 2026-03-10 to 2026-06-10.")
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

  test("comparison prompt binds to explicit SMH target instead of SPY baseline", async () => {
    const result = await bootstrapWorkspace("ses_smh_edge", SMH_EDGE_PROMPT)
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("smh-1h-momentum.")).toBe(true)
    expect(result!.slug).not.toContain("spy")

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("SMH")
    expect(request.requested_interval).toBe("1h")
    expect(request.requested_asset_class).toBe("equity")
    expect(request.requested_algorithm_name).toBe("smh-1h-momentum")
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

  test("saved algorithm store receives flat workspace data and removes the workspace copy", async () => {
    const boot = await bootstrapWorkspace("ses_consol_data", SPY_PROMPT)
    const dataRoot = path.join(boot!.dir, "data")
    await fs.mkdir(path.join(dataRoot, "stock"), { recursive: true })
    await fs.mkdir(path.join(dataRoot, "news"), { recursive: true })
    await fs.mkdir(path.join(dataRoot, "sentiment"), { recursive: true })
    await fs.writeFile(path.join(dataRoot, "stock", "SPY_15m.csv"), "timestamp,open\n", "utf8")
    await fs.writeFile(path.join(dataRoot, "news", "spy-context.md"), "# news\n", "utf8")
    await fs.writeFile(path.join(dataRoot, "sentiment", "SPY_sentiment.csv"), "date,symbol\n", "utf8")

    const storeData = path.join(finnyArtifactPath("algorithms"), "store-with-data", "data")
    await linkAlgorithmToWorkspace("ses_consol_data", {
      algorithmId: "store-with-data",
      name: "spy-with-data",
      version: 1,
    })

    await expect(fs.readFile(path.join(storeData, "stock", "SPY_15m.csv"), "utf8")).resolves.toBe("timestamp,open\n")
    await expect(fs.readFile(path.join(storeData, "news", "spy-context.md"), "utf8")).resolves.toBe("# news\n")
    await expect(fs.readFile(path.join(storeData, "sentiment", "SPY_sentiment.csv"), "utf8")).resolves.toBe(
      "date,symbol\n",
    )
    await expect(fs.stat(path.join(storeData, "news", "body")).catch(() => null)).resolves.toBeNull()
    await expect(fs.stat(path.join(storeData, "news", "headlines")).catch(() => null)).resolves.toBeNull()
    await expect(fs.stat(path.join(storeData, "sentiment", "body")).catch(() => null)).resolves.toBeNull()
    await expect(fs.stat(path.join(storeData, "sentiment", "headlines")).catch(() => null)).resolves.toBeNull()
    await expect(fs.stat(dataRoot).catch(() => null)).resolves.toBeNull()
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
