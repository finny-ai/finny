import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const AGENTS = ["build", "research", "chat", "data_extractor", "researcher"] as const

const KNOWN_TOOL_IDS = [
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

const STALE_REFERENCES = [
  ["finny", "research", "dispatch"].join("_"),
  "research" + "dispatch",
  "Research" + "Dispatch" + "Tool",
]

const sandboxRoot = mkdtempSync(path.join(tmpdir(), "finny-audit-home-"))
for (const dirname of ["share", "cache", "state", "home"]) {
  mkdirSync(path.join(sandboxRoot, dirname), { recursive: true })
}

// Keep this audit runnable in sandboxed/dev environments without touching the
// user's real Finny database or model cache.
process.env.XDG_DATA_HOME = path.join(sandboxRoot, "share")
process.env.XDG_CACHE_HOME = path.join(sandboxRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(sandboxRoot, "config")
process.env.XDG_STATE_HOME = path.join(sandboxRoot, "state")
process.env.OPENCODE_TEST_HOME = path.join(sandboxRoot, "home")
process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(sandboxRoot, "managed")
process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "..", "test", "tool", "fixtures", "models-api.json")

const { Log } = await import("../src/util/log")
await Log.init({ print: false, dev: true, level: "ERROR" })
chmodSync(path.join(sandboxRoot, "config", "finny"), 0o555)
const { Agent } = await import("../src/agent/agent")
const { Permission } = await import("../src/permission")
const { Instance } = await import("../src/project/instance")
const { default: PROMPT_BUILD } = await import("../src/agent/prompt/finny-build.txt")
const { default: PROMPT_RESEARCH } = await import("../src/agent/prompt/finny-research.txt")
const { default: PROMPT_CHAT } = await import("../src/agent/prompt/finny-chat.txt")
const { default: PROMPT_DATA_EXTRACTOR } = await import("../src/agent/prompt/finny-data-extractor.txt")
const { default: PROMPT_RESEARCHER } = await import("../src/agent/prompt/finny-researcher.txt")

const PROMPTS: Record<(typeof AGENTS)[number], string> = {
  build: PROMPT_BUILD,
  research: PROMPT_RESEARCH,
  chat: PROMPT_CHAT,
  data_extractor: PROMPT_DATA_EXTRACTOR,
  researcher: PROMPT_RESEARCHER,
}

function lineCount(text: string) {
  return text.trimEnd().split(/\r?\n/).length
}

function estimatedTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function includesToken(text: string, token: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text)
}

function duplicatedSections(text: string) {
  const headings = text.match(/^#{1,3} .+$/gm) ?? []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const heading of headings) {
    if (seen.has(heading)) duplicates.add(heading)
    seen.add(heading)
  }
  return [...duplicates]
}

const directory = mkdtempSync(path.join(tmpdir(), "finny-audit-"))

await Instance.provide({
  directory,
  fn: async () => {
    const rows = []
    for (const name of AGENTS) {
      const agent = await Agent.get(name)
      if (!agent) throw new Error(`Missing agent: ${name}`)

      const prompt = PROMPTS[name]
      const disabled = Permission.disabled(KNOWN_TOOL_IDS, agent.permission)
      const visibleTools = KNOWN_TOOL_IDS.filter((tool) => !disabled.has(tool)).sort()
      const deniedToolsInPrompt = KNOWN_TOOL_IDS.filter((tool) => disabled.has(tool) && includesToken(prompt, tool)).sort()

      rows.push({
        agent: name,
        promptLines: lineCount(prompt),
        estimatedTokens: estimatedTokens(prompt),
        visibleToolCount: visibleTools.length,
        visibleTools,
        deniedToolsInPrompt,
        staleReferences: STALE_REFERENCES.filter((ref) => prompt.includes(ref)),
        duplicatedSections: duplicatedSections(prompt),
      })
    }

    console.log(JSON.stringify(rows, null, 2))
  },
})

await Instance.disposeAll()
rmSync(sandboxRoot, { recursive: true, force: true })
