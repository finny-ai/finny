import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"
import PROMPT_RESEARCH from "../../src/agent/prompt/finny-research.txt"
import PROMPT_CHAT from "../../src/agent/prompt/finny-chat.txt"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import PROMPT_RESEARCHER from "../../src/agent/prompt/finny-researcher.txt"
import { tmpdir } from "../fixture/fixture"

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
  "finny_backtest_run",
  "finny_backtest_history",
  "finny_backtest_walkforward",
  "finny_backtest_sweep",
  "finny_monitor_snapshot",
  "schedule_subagent",
  "list_subagents",
  "stop_subagent",
  "finny_get_quote",
  "finny_get_history",
  "finny_portfolio_backtest",
  "finny_discord_read",
  "finny_extract_data",
]

const EXPECTED_TOOLS = {
  build: [
    "finny_algorithm_export",
    "finny_algorithm_get",
    "finny_algorithm_list",
    "finny_algorithm_save",
    "finny_algorithm_scaffold",
    "finny_algorithm_set_params",
    "finny_algorithm_validate",
    "finny_algorithm_versions",
    "finny_backtest_run",
    "finny_backtest_walkforward",
    "finny_extract_data",
    "finny_get_history",
    "finny_get_quote",
    "finny_portfolio_backtest",
    "question",
    "read",
    "task",
    "webfetch",
  ],
  research: [
    "finny_algorithm_set_params",
    "finny_extract_data",
    "finny_get_history",
    "finny_get_quote",
    "question",
    "task",
    "webfetch",
  ],
  chat: [
    "finny_algorithm_get",
    "finny_algorithm_list",
    "finny_backtest_history",
    "finny_get_history",
    "finny_get_quote",
    "question",
    "task",
    "webfetch",
  ],
  data_extractor: ["apply_patch", "edit", "finny_extract_data", "read", "write"],
  researcher: ["apply_patch", "edit", "finny_discord_read", "read", "webfetch", "websearch", "write"],
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

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Finny debloat", () => {
  test("primary prompt budgets stay under target", () => {
    expect(lineCount(PROMPT_BUILD)).toBeLessThanOrEqual(210)
    expect(lineCount(PROMPT_RESEARCH)).toBeLessThanOrEqual(120)
    expect(lineCount(PROMPT_CHAT)).toBeLessThanOrEqual(100)
  })

  test("subagent prompt budgets stay under target", () => {
    expect(lineCount(PROMPT_DATA_EXTRACTOR)).toBeLessThanOrEqual(90)
    expect(lineCount(PROMPT_RESEARCHER)).toBeLessThanOrEqual(100)
  })

  test("primary prompts do not reference removed research dispatch tool", () => {
    const combined = [PROMPT_BUILD, PROMPT_RESEARCH, PROMPT_CHAT].join("\n")
    expect(combined).not.toContain(["finny", "research", "dispatch"].join("_"))
    expect(combined).not.toContain("research" + "dispatch")
    expect(combined).not.toContain("Research" + "Dispatch" + "Tool")
  })

  test("primary prompts do not duplicate workflow headings", () => {
    expect(duplicatedSections(PROMPT_BUILD)).toEqual([])
    expect(duplicatedSections(PROMPT_RESEARCH)).toEqual([])
    expect(duplicatedSections(PROMPT_CHAT)).toEqual([])
  })

  test("Finny agents expose only their explicit tool bundles", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
          const agent = await Agent.get(name)
          expect(agent, `missing agent ${name}`).toBeDefined()
          expect(visibleTools(agent!)).toEqual(expected)
        }
      },
    })
  })

  test("Finny primary agents deny generic coding tools", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["build", "research", "chat"]) {
          const agent = await Agent.get(name)
          expect(agent, `missing agent ${name}`).toBeDefined()
          const disabled = Permission.disabled(GENERIC_CODING_TOOLS, agent!.permission)
          const expectedDisabled =
            name === "build" ? GENERIC_CODING_TOOLS.filter((tool) => tool !== "read") : GENERIC_CODING_TOOLS
          expect([...disabled].sort()).toEqual(expectedDisabled.toSorted())
        }
      },
    })
  })

  test("task delegation is limited to the intended subagents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const research = await Agent.get("research")
        const chat = await Agent.get("chat")

        expect(Permission.evaluate("task", "data_extractor", build!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "researcher", build!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "general", build!.permission).action).toBe("deny")

        expect(Permission.evaluate("task", "data_extractor", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "researcher", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "general", research!.permission).action).toBe("deny")

        expect(Permission.evaluate("task", "researcher", chat!.permission).action).toBe("allow")
        expect(Permission.evaluate("task", "data_extractor", chat!.permission).action).toBe("deny")
        expect(Permission.evaluate("task", "general", chat!.permission).action).toBe("deny")
      },
    })
  })

  test("prompt policy covers the critical transcript routes", () => {
    expect(PROMPT_BUILD).toContain("Conceptual/explainer question")
    expect(PROMPT_BUILD).toContain("concrete symbol, universe, tradable")
    expect(PROMPT_BUILD).toContain("Deterministic Build State Machine")
    expect(PROMPT_BUILD).toContain("Parse immutable request facts")
    expect(PROMPT_BUILD).toContain("Mandatory Pre-Build Subagents")
    expect(PROMPT_BUILD).toContain("Use `read` only under `algos/_template/`")
    expect(PROMPT_BUILD).toContain("Read `algos/_template/README.md`")
    expect(PROMPT_BUILD).toContain("Do not use scaffold as a")
    expect(PROMPT_BUILD).toContain('Launch `task(subagent_type="data_extractor")`')
    expect(PROMPT_BUILD).toContain('Launch `task(subagent_type="researcher")`')
    expect(PROMPT_BUILD).toContain("If either result starts with `BLOCKED:`")
    expect(PROMPT_BUILD).toContain("Pass concrete symbol, interval, asset class, strategy intent")
    expect(PROMPT_BUILD).toContain("never backfill or re-patch a complete new save")
    expect(PROMPT_BUILD).toContain("If strict data quality fails, stop")
    expect(PROMPT_BUILD).toContain("ready/backtested")
    expect(PROMPT_BUILD).toContain("valid next steps in this order")
    expect(PROMPT_BUILD).toContain("explicit research-only repair")
    expect(PROMPT_BUILD).toContain("Drift Control")
    expect(PROMPT_BUILD).toContain("`BLOCKED: requested crypto, proposed equity proxy requires approval`")
    expect(PROMPT_BUILD).toContain("Do not save a QQQ/SPY strategy under a BTC/crypto name")
    expect(PROMPT_BUILD).toContain("Positive ROI, but NOT paper")
    expect(PROMPT_BUILD).toContain("Save with `finny_algorithm_save`")
    expect(PROMPT_BUILD).toContain("Run `finny_backtest_run`")

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

    // Mandatory subagent result must be usable or an explicit unusable/BLOCKED.
    expect(PROMPT_BUILD).toContain("BLOCKED: mandatory subagent result unusable")
    expect(PROMPT_BUILD).toContain("no material current context found")
    // Failure-budget wording: count only completed backtest tool failures.
    expect(PROMPT_BUILD).toContain("Count only completed backtest tool failures")
    expect(PROMPT_BUILD).toContain('never "two failures"')
    // Regime mismatch: build the requested concept first, diagnose after.
    expect(PROMPT_BUILD).toContain("Do not ask to pivot away from the requested strategy type")
    // Walk-forward honesty + failure-budget rename loophole.
    expect(PROMPT_BUILD).toContain("if it says FAILED, the strategy failed walk-forward")
    expect(PROMPT_BUILD).toContain('call it "validated" or "robust"')
    expect(PROMPT_BUILD).toContain("does NOT reset the failure budget")
    expect(PROMPT_BUILD).toContain("`userApproved: true`")
    expect(PROMPT_BUILD).toContain("After 3 failed save/validation attempts, stop")
    expect(PROMPT_BUILD).toContain("`write`/`edit` are never allowed in")
    expect(PROMPT_BUILD).toContain("do not save comma-separated `symbol`")
    expect(PROMPT_BUILD).toContain("`finny_portfolio_backtest` or save")
    expect(PROMPT_BUILD).toContain("do not narrow to one ticker")
    // Trade count is a caveat, not a hard cutoff.
    expect(PROMPT_BUILD).toContain("Trade count is a caveat, not a hard cutoff")
    // Per-request workspace: storage routing is automatic, never invented.
    expect(PROMPT_BUILD).toContain("per-request workspace is auto-provisioned")
    expect(PROMPT_BUILD).toContain("never invent one for storage routing")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Storage is bound to your session workspace automatically")
    // Evidence window must cover the full requested backtest duration.
    expect(PROMPT_BUILD).toContain("evidence window must cover the FULL backtest duration")
    expect(PROMPT_BUILD).toContain("never let an intraday extractor fall back to its 30-day default")
    // set_params cannot mutate identity or re-patch a complete new save.
    expect(PROMPT_BUILD).toContain("Use `finny_algorithm_set_params` only for non-identity inputs")
    expect(PROMPT_BUILD).toContain("Never patch")
    expect(PROMPT_BUILD).toContain("symbol, asset class, interval, or brokerage")
    expect(PROMPT_BUILD).toContain("never backfill or re-patch a complete new save")
    expect(PROMPT_BUILD).toContain('Never claim "exported" unless `finny_algorithm_export` ran')
    expect(PROMPT_BUILD).toContain('blocked strict backtest')
    expect(PROMPT_BUILD).toContain("no performance")
    // Subagents must create files directly; the live session showed `edit` on
    // a news directory, which is a recoverable but noisy tool error.
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use `write` with a concrete markdown file path")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not call `edit` on a directory path")
    expect(PROMPT_RESEARCHER).toContain("Use `write` with a concrete markdown file path")
    expect(PROMPT_RESEARCHER).toContain("Do not call `edit` on a directory path")

    expect(PROMPT_RESEARCH).toContain("Conceptual question")
    expect(PROMPT_RESEARCH).toContain("Explicit date range")
    expect(PROMPT_RESEARCH).toContain("Build handoff")
    expect(PROMPT_RESEARCH).toContain("It does not create strategy code, save algorithms, or run new backtests")

    expect(PROMPT_CHAT).toContain("Show my last backtest")
    expect(PROMPT_CHAT).toContain("Use `finny_backtest_history`")
    expect(PROMPT_CHAT).toContain("Tell the user to switch to Build mode")
  })

  test("build agent has enough step budget for mandatory subagents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build?.steps).toBe(35)
      },
    })
  })
})
