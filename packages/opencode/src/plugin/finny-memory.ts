import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  appendCompactionSummary,
  bindSessionWorkspace,
  buildCompactionContext,
  clearActiveAlgo,
  clearSessionWorkspace,
  discoverAlgos,
  getActiveAlgo,
  getSessionWorkspace,
  renderProgressTimeline,
  setActiveAlgo,
  subagentKind,
  writeProgress,
  writeSubagentSummary,
} from "@finny-ai/core/algo"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.finny-memory" })

/** Subagent kinds whose return we treat as "context gathered" for the TODO nudge. */
const TODO_NUDGE_KINDS = new Set(["data", "news"])

const SUBAGENT_SUMMARY_MAX_CHARS = 4_000

/**
 * One-time instruction appended to a subagent's task result once both the data
 * and news context have come back, prompting the agent to record an initial
 * TODO. Deterministic trigger; the model authors the actual TODO content.
 */
const TODO_NUDGE_TEXT = [
  ``,
  `---`,
  `[finny] You now have both data and news context. Before continuing, call \`todowrite\` to record your`,
  `initial plan as a TODO (e.g. review data + news → draft strategy v1 → backtest → iterate). Keep it`,
  `updated as you progress so the plan survives context compaction.`,
].join("\n")

/**
 * Resolve the algo for a session STRICTLY from its per-session binding. We
 * deliberately do not fall back to the machine-global active algo: an unbound
 * session must never read or write another session's workspace artifacts.
 */
async function resolveSessionAlgo(sessionID: string): Promise<string | null> {
  return await getSessionWorkspace(sessionID).catch(() => null)
}

/** First user message, rendered as an "Asked: …" step, or null. */
function firstUserAsk(messages: any[]): string | null {
  for (const msg of messages) {
    if (msg?.info?.role !== "user") continue
    const text = (msg.parts ?? [])
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return `Asked: "${text.length > 80 ? text.slice(0, 79) + "…" : text}"`
  }
  return null
}

/** Render a single completed tool part as a timeline step, or null if uninteresting. */
function progressStepForTool(part: any): string | null {
  if (part?.type !== "tool" || part?.state?.status !== "completed") return null
  const input = part.state?.input ?? {}
  const version = input.version ?? part.state?.metadata?.version
  switch (part.tool) {
    case "task": {
      const sub = typeof input.subagent_type === "string" ? input.subagent_type : "subagent"
      return `Launched ${sub} subagent`
    }
    case "finny_algorithm_save":
      return version ? `Saved strategy ${version}` : "Saved strategy"
    case "finny_backtest_run":
      return version ? `Backtested ${version}` : "Ran backtest"
    default:
      return null
  }
}

/** Walk session messages and render a short "what's been done so far" timeline. */
function extractProgressSteps(messages: any[]): string[] {
  const steps: string[] = []
  const ask = firstUserAsk(messages)
  if (ask) steps.push(ask)
  for (const msg of messages) {
    for (const part of msg?.parts ?? []) {
      const step = progressStepForTool(part)
      if (step) steps.push(step)
    }
  }
  // Collapse consecutive duplicates (e.g. repeated backtests of the same version).
  return steps.filter((step, i) => step !== steps[i - 1])
}

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

async function handleAlgoCommand(raw: string, sessionID?: string): Promise<string> {
  const action = parseAlgoArgs(raw)
  switch (action.kind) {
    case "use":
      try {
        await setActiveAlgo(action.name)
        // Storage-resolving tools read only the per-session binding, so /algo
        // use must bind the current session for the selection to take effect.
        if (sessionID) await bindSessionWorkspace(sessionID, action.name).catch(() => {})
        return `✓ active algo: ${action.name}`
      } catch (err) {
        return `✗ ${err instanceof Error ? err.message : String(err)}`
      }
    case "clear":
      await clearActiveAlgo()
      if (sessionID) await clearSessionWorkspace(sessionID).catch(() => {})
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
  // Capture the compaction target at `experimental.session.compacting` time
  // so the `session.compacted` event writes to the SAME algo even if the
  // user runs `/algo use <other>` (or `/algo clear`) mid-compaction.
  // Re-reading getActiveAlgo() on the post-event would race.
  const compactionTargets = new Map<string, { algo: string; current: string }>()
  // Per-session set of subagent kinds ("data"/"news") whose context has come
  // back, and the set of sessions already nudged to write their initial TODO.
  const subagentContext = new Map<string, Set<string>>()
  const todoNudged = new Set<string>()

  // Best-effort read of a session's TODO list via the SDK. Returns [] on any error.
  async function readSessionTodos(id: string): Promise<{ content: string; status: string }[]> {
    try {
      const res = await client.session.todo({ path: { id } as any })
      const todos = ((res as any)?.data ?? []) as any[]
      return todos
        .filter((t) => t && typeof t.content === "string")
        .map((t) => ({ content: t.content as string, status: typeof t.status === "string" ? t.status : "pending" }))
    } catch {
      return []
    }
  }

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
      const result = await handleAlgoCommand(event.arguments, event.sessionID)
      const replacement = { type: "text", text: result } as any
      output.parts.splice(0, output.parts.length, replacement)
    },

    /**
     * After a data/news subagent returns, (1) persist its summary under the
     * algo's `.finny/` dir so it survives compaction, and (2) once BOTH data
     * and news context have come back, append a one-time nudge to the result
     * telling the agent to record its initial TODO. The nudge is appended to
     * the tool output the model sees next, so the model authors the TODO.
     */
    "tool.execute.after": async (event, output) => {
      if (event.tool !== "task") return
      const subType = typeof event.args?.subagent_type === "string" ? event.args.subagent_type : undefined
      if (!subType) return
      const kind = subagentKind(subType)
      if (!kind) return

      // Require an explicit session binding. Without one we cannot safely
      // attribute artifacts to a workspace, so skip entirely — including the
      // nudge tracking — to avoid recording a session as nudged before its
      // summaries are ever persisted.
      const algo = await resolveSessionAlgo(event.sessionID)
      if (!algo) return

      if (typeof output.output === "string" && output.output.trim()) {
        try {
          await writeSubagentSummary(algo, kind, output.output)
        } catch (err) {
          log.warn("failed to persist subagent summary", {
            algo,
            kind,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Track which context kinds have returned; nudge once both are present.
      if (TODO_NUDGE_KINDS.has(kind)) {
        const seen = subagentContext.get(event.sessionID) ?? new Set<string>()
        seen.add(kind)
        subagentContext.set(event.sessionID, seen)
        const haveBoth = [...TODO_NUDGE_KINDS].every((k) => seen.has(k))
        // Only mark the session nudged when we actually deliver the text, so a
        // non-string output never permanently suppresses the nudge.
        if (haveBoth && !todoNudged.has(event.sessionID) && typeof output.output === "string") {
          todoNudged.add(event.sessionID)
          output.output = output.output + "\n" + TODO_NUDGE_TEXT
        }
      }
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
    "experimental.session.compacting": async (event, output) => {
      const active = await resolveSessionAlgo(event.sessionID)
      if (!active) return
      try {
        const ctx = await buildCompactionContext(active)
        const version = ctx.current ?? "(no version saved yet)"
        compactionTargets.set(event.sessionID, { algo: active, current: version })
        output.context.push(`# Active Finny algo: ${ctx.algo}`, `Current version: ${version}`, ``)
        if (ctx.mission.trim()) {
          output.context.push(`## mission.md`, ctx.mission.trim(), ``)
        }
        if (ctx.current) {
          output.context.push(
            ...(ctx.reasoning
              ? [`## ${ctx.current}/reasoning.md`, ctx.reasoning.trim(), ``]
              : [`(no reasoning.md for ${ctx.current} yet)`, ``]),
          )
        }
        // Re-hand the data/news subagent context gathered earlier this session
        // so the post-compaction agent doesn't lose it.
        for (const summary of ctx.subagentSummaries) {
          const body = summary.body.trim()
          if (!body) continue
          const truncated =
            body.length > SUBAGENT_SUMMARY_MAX_CHARS ? body.slice(0, SUBAGENT_SUMMARY_MAX_CHARS) + "\n…(truncated)" : body
          output.context.push(`## ${summary.kind} subagent summary`, truncated, ``)
        }
        // Re-inject the current TODO list so the regenerated summary's Next
        // Steps reflect outstanding work. Best-effort: fall back silently.
        const todos = await readSessionTodos(event.sessionID)
        if (todos.length) {
          output.context.push(
            `## current TODO`,
            ...todos.map((t) => `- [${t.status === "completed" ? "x" : " "}] ${t.content}`),
            ``,
          )
        }
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
      // Compaction is a natural session boundary: always reset the per-session
      // TODO-nudge state so a fresh stretch of work can be re-nudged, even when
      // there is no algo target to write memory for.
      subagentContext.delete(sessionID)
      todoNudged.delete(sessionID)
      // Use the snapshot captured at compacting time, not whatever
      // getActiveAlgo() returns NOW — the user may have switched algos.
      const target = compactionTargets.get(sessionID)
      compactionTargets.delete(sessionID)
      if (!target) return
      try {
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
        const file = await appendCompactionSummary(target.algo, {
          active_version: target.current,
          body: summary,
        })
        log.info("appended compaction summary to memory.md", { file, algo: target.algo })

        // Build + persist a small "what's been done so far" timeline, and
        // surface it as a toast so the user sees progress at a glance.
        try {
          const steps = extractProgressSteps(messages)
          await writeProgress(
            target.algo,
            renderProgressTimeline({ algo: target.algo, version: target.current, steps }),
          )
          if (steps.length) {
            const shown = steps.slice(-8)
            await client.tui
              .showToast({
                body: {
                  title: `Compacted · ${target.algo}`,
                  message: shown.map((s) => `• ${s}`).join("\n"),
                  variant: "info",
                },
              })
              .catch(() => {})
          }
        } catch (err) {
          log.warn("failed to write progress timeline", {
            algo: target.algo,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      } catch (err) {
        log.warn("failed to append compaction summary to memory.md", {
          algo: target.algo,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
