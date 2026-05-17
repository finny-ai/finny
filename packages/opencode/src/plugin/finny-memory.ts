import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  appendMemoryEntry,
  buildCompactionContext,
  clearActiveAlgo,
  discoverAlgos,
  getActiveAlgo,
  setActiveAlgo,
} from "@finny-ai/core/algo"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.finny-memory" })

const COMMAND_NAME = "algo"

const ALGO_COMMAND_TEMPLATE = [
  "(internal) Finny algo command — handled by plugin.",
  "",
  "$ARGUMENTS",
].join("\n")

const COMPACTION_PROMPT = [
  "You are compacting a Finny strategy-development session.",
  "",
  "Goal: produce a single concise summary the next session can pick up cold.",
  "",
  "Required output: call the `finny_record_memory` tool exactly ONCE at the end with:",
  "  - active_version: the version string from the CURRENT pointer in the algo context",
  "  - summary: 3-6 sentences covering decisions made, data fetched, backtests run, dead ends explored",
  "  - open_threads: array of in-flight investigation items the next session should resume",
  "",
  "Do not narrate. Do not include code. Just the tool call.",
].join("\n")

/**
 * Parse `/algo use <name>` / `/algo clear` / `/algo list` from the raw
 * arguments string. Returns a structured action or an error message.
 */
type AlgoAction =
  | { kind: "use"; name: string }
  | { kind: "clear" }
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "error"; message: string }

export function parseAlgoArgs(raw: string): AlgoAction {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === "status") return { kind: "status" }
  const [verb, ...rest] = trimmed.split(/\s+/)
  if (verb === "use") {
    const name = rest[0]
    if (!name) return { kind: "error", message: "usage: /algo use <name>" }
    return { kind: "use", name }
  }
  if (verb === "clear") return { kind: "clear" }
  if (verb === "list") return { kind: "list" }
  return { kind: "error", message: `unknown subcommand "${verb}". Use: use <name> | clear | list | status` }
}

async function handleAlgoCommand(raw: string): Promise<string> {
  const action = parseAlgoArgs(raw)
  switch (action.kind) {
    case "use":
      try {
        await setActiveAlgo(action.name)
        return `✓ active algo: ${action.name}`
      } catch (err) {
        return `✗ ${err instanceof Error ? err.message : String(err)}`
      }
    case "clear":
      await clearActiveAlgo()
      return "✓ cleared active algo"
    case "list": {
      const names = await discoverAlgos()
      if (names.length === 0) return "(no algos found under ~/.local/share/finny/algos/)"
      const current = await getActiveAlgo()
      return names.map((n) => (n === current ? `* ${n}` : `  ${n}`)).join("\n")
    }
    case "status": {
      const current = await getActiveAlgo()
      return current ? `active algo: ${current}` : "no active algo (use: /algo use <name>)"
    }
    case "error":
      return `✗ ${action.message}`
  }
}

export async function FinnyMemoryPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    /**
     * Register `/algo` so the TUI slash-menu surfaces it. The template is
     * a no-op placeholder; the real work happens in command.execute.before.
     */
    async config(cfg) {
      const commands = (cfg as any).command ?? {}
      if (!commands[COMMAND_NAME]) {
        commands[COMMAND_NAME] = {
          template: ALGO_COMMAND_TEMPLATE,
          description: "Manage the active Finny algo (use|clear|list|status)",
        }
        ;(cfg as any).command = commands
      }
    },

    /**
     * Intercept `/algo` execution. Run the side effect (setActiveAlgo,
     * etc.) and replace the LLM-bound parts with a single text part
     * containing the result. The LLM still runs (we can't suppress it
     * without deeper opencode surgery) but with a tiny prompt that elicits
     * a short ack at worst.
     */
    "command.execute.before": async (input, output) => {
      if (input.command !== COMMAND_NAME) return
      const result = await handleAlgoCommand(input.arguments)
      output.parts = [{ type: "text", text: result } as any]
    },

    /**
     * Before /compact: read the active algo, inject mission/CURRENT/
     * reasoning into the compaction context, and override the prompt to
     * instruct the model to call `finny_record_memory`.
     */
    "experimental.session.compacting": async (_input, output) => {
      const active = await getActiveAlgo()
      if (!active) return
      try {
        const ctx = await buildCompactionContext(active)
        output.context.push(
          `# Active Finny algo: ${ctx.algo}`,
          `Located at: ${ctx.algoDir}`,
          `Current version: ${ctx.current}`,
          ``,
          `## mission.md`,
          ctx.mission,
          ``,
          ...(ctx.reasoning
            ? [`## ${ctx.current}/reasoning.md`, ctx.reasoning]
            : [`(no reasoning.md for ${ctx.current} yet)`]),
        )
        output.prompt = COMPACTION_PROMPT
      } catch (err) {
        log.warn("failed to build compaction context, falling back to default", {
          algo: active,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },

    /**
     * Tool the compaction agent calls to append a dated block to
     * `<algo>/memory.md`. Globally registered (prompt-gated to compaction).
     */
    tool: {
      finny_record_memory: tool({
        description:
          "Append a dated compaction summary to the active Finny algo's memory.md. Call ONCE at the end of compaction.",
        args: {
          active_version: tool.schema
            .string()
            .regex(/^v(?:0[1-9]|[1-9][0-9])$/, "active_version must be vNN (e.g. v01, v02)"),
          summary: tool.schema.string().min(1),
          open_threads: tool.schema.array(tool.schema.string()).default([]),
        },
        async execute(args) {
          const active = await getActiveAlgo()
          if (!active) {
            return "no active Finny algo; memory not recorded"
          }
          const file = await appendMemoryEntry(active, {
            active_version: args.active_version,
            summary: args.summary,
            open_threads: args.open_threads,
          })
          return `appended compaction block to ${file}`
        },
      }),
    },
  }
}
