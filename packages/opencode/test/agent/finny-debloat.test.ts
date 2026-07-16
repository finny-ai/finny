import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import PROMPT_FINNY from "../../src/agent/prompt/finny.txt"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"
import PROMPT_RESEARCH from "../../src/agent/prompt/finny-research.txt"
import PROMPT_CHAT from "../../src/agent/prompt/finny-chat.txt"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import PROMPT_NEWS_AGENT from "../../src/agent/prompt/finny-news-agent.txt"
import PROMPT_SEC_AGENT from "../../src/agent/prompt/finny-sec-agent.txt"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ALL_TOOL_IDS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "task_start",
  "task_run",
  "task_batch_run",
  "webfetch",
  "todowrite",
  "list_tasks",
  "task_status",
  "stop_task",
  "websearch",
  "codesearch",
  "skill",
  "apply_patch",
  "lsp",
  "plan_exit",
  "finny_algorithm_save",
  "finny_algorithm_list",
  "finny_algorithm_get",
  "finny_algorithm_set_params",
  "finny_algorithm_validate",
  "finny_algorithm_scaffold",
  "finny_algorithm_versions",
  "finny_algorithm_export",
  "finny_brokerage_switch",
  "finny_workspace_prepare",
  "finny_backtest",
  "finny_backtest_history",
  "finny_review_packet",
  "finny_paper_approve",
  "finny_workflow_request_approval",
  "finny_backtest_sweep",
  "finny_monitor_snapshot",
  "schedule_subagent",
  "list_subagents",
  "stop_subagent",
  "finny_get_quote",
  "finny_get_history",
  "finny_portfolio_backtest",
  "finny_discord_read",
  "finny_dataset_evidence_finalize",
]

const EXPECTED_TOOLS = {
  finny: [
    "apply_patch",
    "bash",
    "edit",
    "finny_algorithm_export",
    "finny_algorithm_get",
    "finny_algorithm_list",
    "finny_algorithm_save",
    "finny_algorithm_scaffold",
    "finny_algorithm_set_params",
    "finny_algorithm_versions",
    "finny_backtest",
    "finny_get_history",
    "finny_get_quote",
    "finny_paper_approve",
    "finny_portfolio_backtest",
    "finny_review_packet",
    "finny_workflow_request_approval",
    "finny_workspace_prepare",
    "question",
    "read",
    "skill",
    "task",
    "task_batch_run",
    "task_run",
    "task_start",
    "todowrite",
    "webfetch",
    "websearch",
    "write",
  ],
  build: [
    "finny_algorithm_export",
    "finny_algorithm_get",
    "finny_algorithm_list",
    "finny_algorithm_save",
    "finny_algorithm_scaffold",
    "finny_algorithm_set_params",
    "finny_algorithm_validate",
    "finny_algorithm_versions",
    "finny_backtest",
    "finny_get_quote",
    "finny_paper_approve",
    "finny_portfolio_backtest",
    "finny_review_packet",
    "finny_workflow_request_approval",
    "finny_workspace_prepare",
    "question",
    "read",
    "skill",
    "task",
    "task_batch_run",
    "task_run",
    "task_start",
    "webfetch",
  ],
  research: [
    "finny_algorithm_set_params",
    "finny_get_history",
    "finny_get_quote",
    "finny_workspace_prepare",
    "question",
    "skill",
    "task",
    "task_batch_run",
    "task_run",
    "task_start",
    "webfetch",
  ],
  chat: [
    "finny_algorithm_get",
    "finny_algorithm_list",
    "finny_backtest_history",
    "finny_get_history",
    "finny_get_quote",
    "question",
    "skill",
    "task",
    "task_batch_run",
    "task_run",
    "task_start",
    "webfetch",
  ],
  data_extractor: ["bash", "finny_dataset_evidence_finalize", "read", "skill"],
  news_agent: ["apply_patch", "edit", "finny_discord_read", "read", "webfetch", "websearch", "write"],
  sec_agent: ["apply_patch", "bash", "edit", "read", "webfetch", "websearch", "write"],
}

const GENERIC_CODING_TOOLS = ["bash", "read", "glob", "grep", "edit", "write", "apply_patch", "lsp", "codesearch"]

function lineCount(text: string) {
  return text.trimEnd().split(/\r?\n/).length
}

function visibleTools(agent: Agent.Info) {
  const disabled = Permission.disabled(ALL_TOOL_IDS, agent.permission)
  return ALL_TOOL_IDS.filter((tool) => !disabled.has(tool)).sort()
}

function duplicatedSections(prompt: string) {
  const headings = prompt.match(/^#{1,3} .+$/gm) ?? []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const heading of headings) {
    if (seen.has(heading)) duplicates.add(heading)
    seen.add(heading)
  }
  return [...duplicates]
}

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

describe("Finny debloat", () => {
  test("primary prompt budgets stay under target", () => {
    expect(lineCount(PROMPT_FINNY)).toBeLessThanOrEqual(170)
    expect(lineCount(PROMPT_BUILD)).toBeLessThanOrEqual(275)
    expect(lineCount(PROMPT_RESEARCH)).toBeLessThanOrEqual(120)
    expect(lineCount(PROMPT_CHAT)).toBeLessThanOrEqual(100)
  })

  test("subagent prompt budgets stay under target", () => {
    expect(lineCount(PROMPT_DATA_EXTRACTOR)).toBeLessThanOrEqual(120)
    expect(lineCount(PROMPT_NEWS_AGENT)).toBeLessThanOrEqual(100)
    expect(lineCount(PROMPT_SEC_AGENT)).toBeLessThanOrEqual(100)
  })

  test("primary prompts do not reference removed research dispatch tool", () => {
    const combined = [PROMPT_FINNY, PROMPT_BUILD, PROMPT_RESEARCH, PROMPT_CHAT].join("\n")
    expect(combined).not.toContain(["finny", "research", "dispatch"].join("_"))
    expect(combined).not.toContain("research" + "dispatch")
    expect(combined).not.toContain("Research" + "Dispatch" + "Tool")
  })

  test("primary prompts do not duplicate workflow headings", () => {
    expect(duplicatedSections(PROMPT_FINNY)).toEqual([])
    expect(duplicatedSections(PROMPT_BUILD)).toEqual([])
    expect(duplicatedSections(PROMPT_RESEARCH)).toEqual([])
    expect(duplicatedSections(PROMPT_CHAT)).toEqual([])
  })

  it.instance("Finny agents expose only their explicit tool bundles", () =>
    Effect.gen(function* () {
      const agentService = yield* Agent.Service
      for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
        const agent = yield* agentService.get(name)
        expect(agent, `missing agent ${name}`).toBeDefined()
        expect(visibleTools(agent!)).toEqual(expected)
      }
    }),
  )

  it.instance("paper approval remains human-confirmed in Finny agents", () =>
    Effect.gen(function* () {
      const agentService = yield* Agent.Service
      for (const name of ["finny", "build"]) {
        const agent = yield* agentService.get(name)
        expect(agent, `missing agent ${name}`).toBeDefined()
        expect(Permission.evaluate("finny_paper_approve", "*", agent!.permission).action).toBe("ask")
      }
    }),
  )

  it.instance("Finny primary agents deny generic coding tools", () =>
    Effect.gen(function* () {
      const agentService = yield* Agent.Service
      for (const name of ["build", "research", "chat"]) {
        const agent = yield* agentService.get(name)
        expect(agent, `missing agent ${name}`).toBeDefined()
        const disabled = Permission.disabled(GENERIC_CODING_TOOLS, agent!.permission)
        const expectedDisabled =
          name === "build" ? GENERIC_CODING_TOOLS.filter((tool) => tool !== "read") : GENERIC_CODING_TOOLS
        expect([...disabled].sort()).toEqual(expectedDisabled.toSorted())
      }
      const finny = yield* agentService.get("finny")
      expect(finny, "missing agent finny").toBeDefined()
      const finnyDisabled = Permission.disabled(GENERIC_CODING_TOOLS, finny!.permission)
      expect([...finnyDisabled].sort()).toEqual(["codesearch", "glob", "grep", "lsp"].toSorted())
    }),
  )

  it.instance("build agent allows repo-root template and data-agent reads by absolute path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const agentService = yield* Agent.Service
      const build = yield* agentService.get("build")
      expect(build).toBeDefined()

      expect(Permission.evaluate("read", path.join(test.directory, "algos/_template"), build!.permission).action).toBe(
        "allow",
      )
      expect(
        Permission.evaluate("read", path.join(test.directory, "algos/_template/README.md"), build!.permission).action,
      ).toBe("allow")
      expect(
        Permission.evaluate("read", path.join(test.directory, "data-agent/instructions.md"), build!.permission).action,
      ).toBe("allow")
    }),
  )

  it.instance("task delegation is limited to the intended subagents", () =>
    Effect.gen(function* () {
      const agentService = yield* Agent.Service
      const finny = yield* agentService.get("finny")
      const build = yield* agentService.get("build")
      const research = yield* agentService.get("research")
      const chat = yield* agentService.get("chat")

      expect(Permission.evaluate("task", "data_extractor", finny!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "news_agent", finny!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sec_agent", finny!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sentiment_agent", finny!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "general", finny!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "explore", finny!.permission).action).toBe("deny")

      expect(Permission.evaluate("task", "data_extractor", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "news_agent", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sec_agent", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "general", build!.permission).action).toBe("deny")

      expect(Permission.evaluate("task", "data_extractor", research!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "news_agent", research!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "sec_agent", research!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", research!.permission).action).toBe("deny")
      expect(Permission.evaluate("finny_workspace_prepare", "*", research!.permission).action).toBe("allow")
      expect(Permission.evaluate("finny_workspace_prepare", "*", build!.permission).action).toBe("allow")

      expect(Permission.evaluate("task", "news_agent", chat!.permission).action).toBe("allow")
      expect(Permission.evaluate("task", "data_extractor", chat!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "sec_agent", chat!.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", chat!.permission).action).toBe("deny")
    }),
  )

  test("prompt policy covers the critical transcript routes", () => {
    expect(PROMPT_FINNY).toContain("expert trading-strategy research and implementation agent")
    expect(PROMPT_FINNY).toContain("todowrite")
    expect(PROMPT_FINNY).toContain("Do not silently assume horizon")
    expect(PROMPT_FINNY).toContain("launching `data_extractor` plus a relevant context agent is highly recommended")
    expect(PROMPT_FINNY).toContain("This is not a universal hard gate")
    expect(PROMPT_FINNY).toContain("Do not launch `news_agent` merely to satisfy a fixed two-agent count")
    expect(PROMPT_FINNY).toContain("simple revisions")
    expect(PROMPT_FINNY).not.toContain("launch at least two evidence subagents before strategy synthesis")
    expect(PROMPT_FINNY).toContain("finny_workspace_prepare")
    expect(PROMPT_FINNY).toContain("The session-bound workspace is the source of truth")
    expect(PROMPT_FINNY).toContain("finny_algorithm_save`")
    expect(PROMPT_FINNY).toContain("validates the strategy and config in the same call")
    expect(PROMPT_FINNY).toContain("research_exception")
    expect(PROMPT_FINNY).toContain("paper_watchlist")
    expect(PROMPT_FINNY).toContain("live_eligible")
    expect(PROMPT_FINNY).toContain('bar["open"]')
    expect(PROMPT_FINNY).toContain("Strategy-build data evidence should come from `data_extractor`")
    expect(PROMPT_FINNY).not.toContain("finny_discord_read")

    expect(PROMPT_BUILD).toContain("Conceptual/explainer question")
    expect(PROMPT_BUILD).toContain("ask one concise round with `question`")
    expect(PROMPT_BUILD).toContain("do not print a plain-text questionnaire")
    expect(PROMPT_BUILD).toContain("noninteractive/tool-unavailable runs")
    expect(PROMPT_BUILD).toContain("`BLOCKED: missing build facts")
    expect(PROMPT_BUILD).toContain("Bare strategy slugs that embed symbol, interval, and intent")
    expect(PROMPT_BUILD).toContain("`spy-5m-momentum`")
    expect(PROMPT_BUILD).toContain("Deterministic Build State Machine")
    expect(PROMPT_BUILD).toContain("Parse immutable request facts")
    expect(PROMPT_BUILD).toContain("Recommended Pre-Build Evidence")
    expect(PROMPT_BUILD).toContain("highly recommended but not universally mandatory")
    expect(PROMPT_BUILD).toContain("Do not launch agents solely to satisfy a fixed agent count")
    expect(PROMPT_BUILD).toContain("review-packet requests should not automatically launch evidence agents")
    expect(PROMPT_BUILD).toContain("Use `read` only under `algos/_template/`")
    expect(PROMPT_BUILD).toContain("Never read `.env` files")
    expect(PROMPT_BUILD).toContain("Read `algos/_template/README.md`")
    expect(PROMPT_BUILD).toContain("Do not use scaffold as a")
    expect(PROMPT_BUILD).toContain("BLOCKED: template read failed")
    expect(PROMPT_BUILD).toContain("never proceed without the template contract")
    expect(PROMPT_BUILD).toContain("Do not call `finny_algorithm_scaffold`")
    expect(PROMPT_BUILD).toContain("in parallel with selected evidence")
    expect(PROMPT_BUILD).toContain("Treat an optional agent blocker as a caveat")
    expect(PROMPT_BUILD).toContain("Pass concrete symbol, interval, asset class, strategy intent")
    expect(PROMPT_BUILD).toContain("Build itself must not read data-agent instruction files")
    expect(PROMPT_BUILD).toContain("never backfill or re-patch a complete new save")
    expect(PROMPT_BUILD).toContain("If strict data quality fails, stop")
    expect(PROMPT_BUILD).toContain("ready/backtested")
    expect(PROMPT_BUILD).toContain("Offer next steps")
    expect(PROMPT_BUILD).toContain("explicit research-only repair")
    expect(PROMPT_BUILD).toContain("provider lookback limit")
    expect(PROMPT_BUILD).toContain("default status/date")
    expect(PROMPT_BUILD).toContain("Never infer entry signal, exit/invalidation rules, risk tolerance, or max drawdown")
    expect(PROMPT_BUILD).toContain("ask one concise `question` round before launching subagents")
    expect(PROMPT_BUILD).not.toContain("discovery is complete; do not ask for thesis/regime wording")
    expect(PROMPT_BUILD).toContain("asset_class: equities")
    expect(PROMPT_BUILD).toContain("data provenance")
    expect(PROMPT_BUILD).toContain("`BACKTESTED`, `INCONCLUSIVE`, `BLOCKED: evidence`, or `FAILED validation`")
    expect(PROMPT_BUILD).toContain("Blocked evidence reports must close with")
    expect(PROMPT_BUILD).toContain("Do not add a question")
    expect(PROMPT_BUILD).toContain("No performance metrics produced")
    expect(PROMPT_BUILD).toContain("Avoid promotional regime language")
    expect(PROMPT_BUILD).toContain("Do not call `finny_get_history` as a substitute")
    expect(PROMPT_BUILD).toContain("Drift Control")
    expect(PROMPT_BUILD).toContain("`BLOCKED: requested crypto, proposed equity proxy requires approval`")
    expect(PROMPT_BUILD).toContain("Do not save a QQQ/SPY strategy under a BTC/crypto name")
    expect(PROMPT_BUILD).toContain("Positive MTM return, but")
    expect(PROMPT_BUILD).toContain("Save with `finny_algorithm_save`")
    expect(PROMPT_BUILD).toContain("Run `finny_backtest`")

    expect(PROMPT_BUILD).toContain("Context Integrity")
    expect(PROMPT_BUILD).toContain("`BLOCKED: context mismatch`")
    expect(PROMPT_BUILD).toContain("never globally reusable")
    expect(PROMPT_BUILD).toContain("Verify it against the immutable request facts")
    expect(PROMPT_BUILD).toContain("never infer relevance from prose")
    expect(PROMPT_BUILD).toContain("btc-usdt-5m-momentum")

    expect(PROMPT_DATA_EXTRACTOR).toContain("Request Identity Contract")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never reuse another algorithm's note")
    expect(PROMPT_DATA_EXTRACTOR).toContain("request identity block at the very top")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`BLOCKED: context mismatch`")

    // saveMode policy: no silent version-bump on a "new" request.
    expect(PROMPT_BUILD).toContain("do not silently switch to")
    expect(PROMPT_BUILD).toContain("if save returns `name_taken`")
    expect(PROMPT_BUILD).toContain("Use `version` only to update/improve/fix a named existing algorithm")

    // Selected evidence must be verified before use without becoming a universal gate.
    expect(PROMPT_BUILD).toContain("If evidence was launched, verify each result's identity metadata")
    expect(PROMPT_BUILD).toContain("Treat an optional agent blocker as a caveat")
    expect(PROMPT_BUILD).toContain("identity mismatch that would make it unsafe to use")
    // Failed variants pivot from evidence without a fixed trial budget.
    expect(PROMPT_BUILD).toContain("After failed variants, summarize the evidence")
    expect(PROMPT_BUILD).toContain("Do not claim a fixed trial budget")
    expect(PROMPT_BUILD).toContain("do not present the build as complete")
    expect(PROMPT_BUILD).toContain("total return is positive")
    // Regime mismatch: build the requested concept first, diagnose after.
    expect(PROMPT_BUILD).toContain("Do not ask to pivot away from the requested strategy type")
    // Walk-forward honesty + terminal review packet.
    expect(PROMPT_BUILD).toContain("Do not produce a final review packet after each iteration")
    expect(PROMPT_BUILD).toContain("alpha vs buy-and-hold")
    expect(PROMPT_BUILD).toContain("Review packet not produced")
    expect(PROMPT_BUILD).toContain("Do not call the run positive")
    expect(PROMPT_BUILD).toContain("After 3 failed save/validation attempts, stop")
    expect(PROMPT_BUILD).toContain("discovery is closed for this request")
    expect(PROMPT_BUILD).toContain("Do not ask the Core")
    expect(PROMPT_BUILD).toContain("renewed discovery prompt")
    expect(PROMPT_BUILD).toContain("`write`/`edit` are never allowed in")
    expect(PROMPT_BUILD).toContain("do not save comma-separated `symbol`")
    expect(PROMPT_BUILD).toContain("`finny_portfolio_backtest` or save")
    expect(PROMPT_BUILD).toContain("do not narrow to one ticker")
    expect(PROMPT_BUILD).toContain("Launch one concrete-symbol `data_extractor` task per portfolio ticker")
    expect(PROMPT_BUILD).toContain("Do not put multiple `data_extractor` entries in one `task_batch_run`")
    expect(PROMPT_BUILD).toContain("batch mode requires distinct subagent types")
    expect(PROMPT_BUILD).toContain("until every requested ticker has verified data evidence")
    // Low closed trade count is inconclusive, not a positive caveat.
    expect(PROMPT_BUILD).toContain("Closed trade count below the dynamic minimum is an inconclusive result")
    // Per-request workspace: storage routing is automatic, never invented.
    expect(PROMPT_BUILD).toContain("per-request workspace is auto-provisioned")
    expect(PROMPT_BUILD).toContain("never invent one for storage routing")
    expect(PROMPT_BUILD).toContain("`data-agent/instructions.md`, not")
    expect(PROMPT_BUILD).toContain("injected `workspace_news_dir`")
    expect(PROMPT_BUILD).toContain("market_universe")
    expect(PROMPT_BUILD).toContain("backtest_window_success_metric")
    expect(PROMPT_BUILD).toContain("do not end with an approval question")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Storage is bound to your session workspace")
    expect(PROMPT_DATA_EXTRACTOR).toContain("workspace_slug")
    expect(PROMPT_DATA_EXTRACTOR).toContain("do not report it as `requested_algorithm_name`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("runtime-injected context block")
    expect(PROMPT_DATA_EXTRACTOR).toContain("requested_start/requested_end")
    expect(PROMPT_DATA_EXTRACTOR).toContain("actual_start/actual_end")
    // Evidence window must cover the full requested backtest duration.
    expect(PROMPT_BUILD).toContain("evidence window must cover the FULL backtest duration")
    expect(PROMPT_BUILD).toContain("never let an intraday extractor fall back to its 30-day default")
    // set_params cannot mutate identity or re-patch a complete new save.
    expect(PROMPT_BUILD).toContain("Use `finny_algorithm_set_params` only for non-identity inputs")
    expect(PROMPT_BUILD).toContain("Never patch")
    expect(PROMPT_BUILD).toContain("symbol, asset class, interval, or brokerage")
    expect(PROMPT_BUILD).toContain("never backfill or re-patch a complete new save")
    expect(PROMPT_BUILD).toContain('Never claim "exported" unless `finny_algorithm_export` ran')
    expect(PROMPT_BUILD).toContain("blocked strict backtest")
    expect(PROMPT_BUILD).toContain("no performance")
    // Failure diagnosis contract: inspect classification before revising.
    expect(PROMPT_BUILD).toContain("Read `failure_diagnosis`")
    expect(PROMPT_BUILD).toContain("`zero_trades` -> fix")
    expect(PROMPT_BUILD).toContain("`sizing_failure` -> fix")
    expect(PROMPT_BUILD).toContain("`strategy_loss`")
    expect(PROMPT_BUILD).toContain("do NOT blame data/backtest")
    expect(PROMPT_BUILD).toContain("never ask backtest vs strategy when metrics exist")
    expect(PROMPT_BUILD).toContain("failed runs include `failure_diagnosis`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Only write through guarded `bash`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("pagination/cursor plan")
    expect(PROMPT_DATA_EXTRACTOR).toContain("A 1000-row Binance kline page is not provider-truncated partial coverage")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not read `.env` or `.env.*`")
    expect(PROMPT_NEWS_AGENT).toContain("Use `write` with a concrete markdown file path")
    expect(PROMPT_NEWS_AGENT).toContain("workspace_news_dir")
    expect(PROMPT_NEWS_AGENT).toContain("Do not write to `algos/_template/data/news`")
    expect(PROMPT_NEWS_AGENT).toContain("Do not call `edit` on a directory path")
    expect(PROMPT_NEWS_AGENT).toContain("News Agent Brief")
    expect(PROMPT_NEWS_AGENT).toContain("Data Provenance / Reproducibility")

    expect(PROMPT_RESEARCH).toContain("Conceptual question")
    expect(PROMPT_RESEARCH).toContain("Explicit date range")
    expect(PROMPT_RESEARCH).toContain("Build handoff")
    expect(PROMPT_RESEARCH).toContain("It does not create strategy code, save algorithms, or run new backtests")
    expect(PROMPT_RESEARCH).toContain("Data request context")
    expect(PROMPT_RESEARCH).toContain("Historical date-range data")
    expect(PROMPT_RESEARCH).toContain("`task_run(data_extractor)` / `task_start(data_extractor)`")
    expect(PROMPT_RESEARCH).toContain("Discovery First")
    expect(PROMPT_RESEARCH).toContain("Deep current-news scan requested")

    expect(PROMPT_CHAT).toContain("finny_backtest_history")
    expect(PROMPT_CHAT).toContain("Use **Research** for guided strategy discovery")
    expect(PROMPT_CHAT).toContain("Optional current-news brief")
  })
})
