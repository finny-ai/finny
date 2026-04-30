import { Log } from "../util/log"
import { Job } from "./job"
import { Server } from "../server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Permission } from "../permission"

export namespace PromptRunner {
  const log = Log.create({ service: "cron.prompt-runner" })
  const TIMEOUT_MS = 5 * 60_000

  export type Result = {
    ok: boolean
    text?: string
    error?: string
  }

  /**
   * Headless prompt invocation, mirroring the in-process SDK pattern from
   * cli/cmd/run.ts:680-687. Runs the prompt against the same Server singleton
   * that the scheduler is hosted in (Server.Default()) — no extra HTTP hop.
   *
   * Cron sessions are locked down with the same deny-list as `finny run`:
   * no permission questions, no plan transitions. Bash/write/edit etc. are
   * gated by the agent's own tool config — if you don't want a tool callable
   * from cron, scope it out in the agent's frontmatter.
   *
   * Lifecycle: each run creates a session, prompts it, collects the final
   * assistant text, then deletes the session in a finally block. Without
   * cleanup the local session DB grows unbounded over time (e.g. a daily
   * job over a year leaves 365 dead sessions and their messages on disk).
   */
  export async function run(job: Job.Schema): Promise<Result> {
    if (job.kind !== "prompt") return { ok: false, error: "job is not a prompt job" }

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      return Server.Default().app.fetch(request)
    }) as typeof globalThis.fetch
    const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })

    const rules: Permission.Ruleset = [
      { permission: "question", action: "deny", pattern: "*" },
      { permission: "plan_enter", action: "deny", pattern: "*" },
      { permission: "plan_exit", action: "deny", pattern: "*" },
    ]

    let sessionID: string | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    try {
      const created = await sdk.session.create({ title: `cron:${job.name}`, permission: rules })
      sessionID = created.data?.id
      if (!sessionID) return { ok: false, error: "session creation returned no id" }

      const collected: string[] = []
      let firstError: string | undefined
      const events = await sdk.event.subscribe()

      const consume = (async () => {
        for await (const event of events.stream) {
          if (cancelled) return
          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue
            if (part.type === "text" && part.time?.end) {
              const text = (part as any).text?.trim?.() ?? ""
              if (text) collected.push(text)
            }
          }
          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            const msg =
              (typeof props.error === "object" && "data" in props.error && (props.error as any).data?.message) ||
              String((props.error as any).name ?? "session error")
            firstError ??= String(msg)
          }
          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            return
          }
          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            // Anything that escapes the rule set above gets rejected. Cron
            // must never block on user input.
            await sdk.permission.reply({ requestID: permission.id, reply: "reject" })
          }
        }
      })()

      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          cancelled = true
          resolve("timeout")
        }, TIMEOUT_MS)
      })

      await sdk.session.prompt({
        sessionID,
        agent: job.prompt.agent,
        parts: [{ type: "text", text: job.prompt.text }],
      })

      const outcome = await Promise.race([consume.then(() => "done" as const), timeoutPromise])
      if (outcome === "timeout") {
        log.warn("prompt.runner.timeout", { jobId: job.id })
        return { ok: false, error: `prompt timed out after ${TIMEOUT_MS / 1000}s` }
      }

      if (firstError) return { ok: false, error: firstError }
      const text = collected.join("\n\n").trim()
      return { ok: true, text: text || "(no assistant text)" }
    } catch (err) {
      log.error("prompt.runner.threw", { jobId: job.id, err: String(err) })
      return { ok: false, error: String(err).slice(0, 250) }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (sessionID) {
        // Best-effort cleanup. If delete fails (e.g. server already torn
        // down), we just log it — cron should never fail the run because
        // cleanup couldn't reach the server.
        await sdk.session.delete({ sessionID }).catch((err) => {
          log.warn("prompt.runner.session-delete-failed", { sessionID, err: String(err) })
        })
      }
    }
  }
}
