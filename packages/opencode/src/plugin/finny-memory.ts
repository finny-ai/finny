import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  appendCompactionSummary,
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

/**
 * Parse `/algo use <name>` / `/algo clear` / `/algo list` / `/algo status`.
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
      if (names.length === 0) return "(no algos found)"
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

export async function FinnyMemoryPlugin(input: PluginInput): Promise<Hooks> {
  const client = input.client
  // Track whether we own the `/algo` command. If a user already defined
  // one in their opencode config, leave it alone and do not intercept it.
  let ownsAlgoCommand = false

  return {
    /**
     * Inject `/algo` into the slash menu only if no user-defined command
     * already exists. Tracks ownership so command.execute.before below
     * doesn't hijack a user-defined `/algo`.
     */
    async config(cfg) {
      const commands: Record<string, any> = (cfg as any).command ?? {}
      if (!commands[COMMAND_NAME]) {
        commands[COMMAND_NAME] = {
          template: ALGO_COMMAND_TEMPLATE,
          description: "Manage the active Finny algo (use|clear|list|status)",
        }
        ;(cfg as any).command = commands
        ownsAlgoCommand = true
      }
    },

    /**
     * Intercept `/algo` execution and replace the LLM-bound parts with the
     * subcommand result. The hook receives `output` with a `parts` array
     * that the caller (session/prompt.ts) holds by reference; we must
     * MUTATE it in place — reassigning `output.parts` would not be visible
     * downstream.
     */
    "command.execute.before": async (event, output) => {
      if (event.command !== COMMAND_NAME) return
      if (!ownsAlgoCommand) return
      const result = await handleAlgoCommand(event.arguments)
      const replacement = { type: "text", text: result } as any
      output.parts.splice(0, output.parts.length, replacement)
    },

    /**
     * Before /compact: append mission + CURRENT + reasoning to the
     * compaction context. We deliberately do NOT override `output.prompt`
     * — opencode's compaction code uses `prompt ?? [defaultPrompt, ...context]`,
     * so overriding the prompt would discard everything we pushed.
     *
     * Absolute paths intentionally omitted from context to avoid leaking
     * local user/environment identifiers to the model.
     */
    "experimental.session.compacting": async (_event, output) => {
      const active = await getActiveAlgo()
      if (!active) return
      try {
        const ctx = await buildCompactionContext(active)
        output.context.push(
          `# Active Finny algo: ${ctx.algo}`,
          `Current version: ${ctx.current}`,
          ``,
          `## mission.md`,
          ctx.mission.trim(),
          ``,
          ...(ctx.reasoning
            ? [`## ${ctx.current}/reasoning.md`, ctx.reasoning.trim(), ``]
            : [`(no reasoning.md for ${ctx.current} yet)`, ``]),
        )
      } catch (err) {
        log.warn("failed to build compaction context, falling back to default", {
          algo: active,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },

    /**
     * After /compact succeeds, fetch the compaction summary message and
     * append it verbatim to <algo>/memory.md. Using the event hook is the
     * only way to record memory — the compaction agent runs with
     * `tools: {}` (see src/session/compaction.ts), so a plugin-registered
     * tool would be unreachable from that path.
     */
    async event(evt) {
      if (evt.event.type !== "session.compacted") return
      const sessionID = (evt.event as any).properties?.sessionID
      if (typeof sessionID !== "string") return
      const active = await getActiveAlgo()
      if (!active) return
      try {
        const ctx = await buildCompactionContext(active)
        const res = await client.session.messages({ path: { id: sessionID } as any })
        const messages = ((res as any)?.data ?? []) as any[]
        // Compaction emits the latest assistant message with summary: true.
        const compactionMsg = [...messages]
          .reverse()
          .find((m) => m?.info?.role === "assistant" && m?.info?.summary === true)
        if (!compactionMsg) {
          log.warn("session.compacted fired but no summary message found", { sessionID })
          return
        }
        const summary = (compactionMsg.parts ?? [])
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text as string)
          .join("\n\n")
          .trim()
        if (!summary) {
          log.warn("compaction summary has no text content", { sessionID })
          return
        }
        const file = await appendCompactionSummary(active, {
          active_version: ctx.current,
          body: summary,
        })
        log.info("appended compaction summary to memory.md", { file, algo: active })
      } catch (err) {
        log.warn("failed to append compaction summary to memory.md", {
          algo: active,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
