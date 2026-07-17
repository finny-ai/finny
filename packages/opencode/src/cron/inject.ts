import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { Server } from "../server/server"
import { Notify } from "./notify"
import { Log } from "../util/log"
import { WatcherState } from "./watcher-state"
import { Analytics } from "@/analytics/tracker"
import { AppRuntime } from "@/effect/app-runtime"

export namespace Inject {
  const log = Log.create({ service: "cron.inject" })
  const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000
  const FALLBACK_RATE_LIMIT_MS = 60 * 60 * 1000

  type PendingEntry = {
    text: string
    enqueuedAt: number
    title?: string
    pendingJobID?: string
  }

  const queue = new Map<string, PendingEntry[]>()
  const flushing = new Set<string>()
  const lastFallbackAt = new Map<string, number>()
  // Local cache of session status, kept in sync with bus events. Seeded once
  // from the app runtime on first ensureSubscription so we don't treat a
  // pre-existing busy session as idle. Unknown sessions after seeding default
  // to idle (matches SessionStatus's own default).
  const sessionStatus = new Map<string, SessionStatus.Info>()
  let unsubscribe: (() => void) | undefined
  let seedPromise: Promise<void> | undefined

  function sdk() {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      return Server.Default().app.fetch(request)
    }) as typeof globalThis.fetch
    return createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
  }

  function ensureSubscription() {
    if (unsubscribe) return
    // Subscribe FIRST so we don't miss events that fire between the seed query
    // and us being ready to listen. Any keys the subscription writes will be
    // preserved by the merge step inside seedStatus.
    const listener = (event: GlobalEvent) => {
      if (event.payload?.type !== SessionStatus.Event.Status.type) return
      const { sessionID, status } = event.payload.properties as typeof SessionStatus.Event.Status.data.Type
      if (status.type === "idle") sessionStatus.delete(sessionID)
      else sessionStatus.set(sessionID, status)

      if (status.type !== "idle") return
      void flush(sessionID).catch((err) => {
        log.warn("inject.flush.failed", { sessionID, err: String(err) })
      })
      void retryPending(sessionID).catch((err) => {
        log.warn("inject.retry-pending.failed", { sessionID, err: String(err) })
      })
    }
    GlobalBus.on("event", listener)
    unsubscribe = () => GlobalBus.off("event", listener)
    // Fire-and-forget; pending deliveries will await this via getStatus.
    seedPromise = seedStatus().catch((err) => {
      log.warn("inject.seed.failed", { err: String(err) })
    })
  }

  async function seedStatus() {
    const snapshot = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionStatus.Service
        return yield* svc.list()
      }),
    )
    // Subscription writes win — they reflect events that arrived AFTER the
    // snapshot was taken, so they're fresher. Only seed keys we haven't yet
    // observed from the bus.
    for (const [sid, status] of snapshot) {
      if (!sessionStatus.has(sid)) sessionStatus.set(sid, status)
    }
  }

  /**
   * Read current status. Awaits the initial seed to avoid the cold-start race
   * where an unknown session is treated as idle before we've snapshotted the
   * real state. After seeding completes, unknown sessions default to idle —
   * any session created after seed would have emitted a status event we'd
   * have caught via the subscription.
   */
  async function getStatus(sessionID: string): Promise<SessionStatus.Info> {
    if (seedPromise) await seedPromise
    return sessionStatus.get(sessionID) ?? { type: "idle" }
  }

  /** Tear down the bus subscription and clear in-memory state. Used by Scheduler.stop. */
  export function shutdown() {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch (err) {
        log.warn("inject.shutdown.unsubscribe-failed", { err: String(err) })
      }
      unsubscribe = undefined
    }
    queue.clear()
    flushing.clear()
    lastFallbackAt.clear()
    sessionStatus.clear()
    seedPromise = undefined
  }

  /**
   * Resolve a session, distinguishing "session not found" (returns null)
   * from "transient lookup error" (returns the error). Callers should treat
   * `{ kind: "missing" }` as terminal (fallback) and `{ kind: "error" }` as
   * retryable (keep queue intact).
   */
  async function resolveSession(sessionID: string): Promise<
    | { kind: "ok"; session: Awaited<ReturnType<typeof Session.get>> }
    | { kind: "missing" }
    | { kind: "error"; err: unknown }
  > {
    try {
      const session = await Session.get(SessionID.make(sessionID))
      if (!session) return { kind: "missing" }
      return { kind: "ok", session }
    } catch (err) {
      return { kind: "error", err }
    }
  }

  function queueEntry(sessionID: string, entry: PendingEntry) {
    const existing = queue.get(sessionID) ?? []
    existing.push(entry)
    queue.set(sessionID, existing)
  }

  /** True if the in-memory queue has an entry for this jobID, regardless of session. */
  function hasQueuedJob(jobID: string): boolean {
    for (const entries of queue.values()) {
      for (const entry of entries) {
        if (entry.pendingJobID === jobID) return true
      }
    }
    return false
  }

  function dropExpired(sessionID: string) {
    const existing = queue.get(sessionID)
    if (!existing?.length) return
    const now = Date.now()
    const fresh = existing.filter((entry) => now - entry.enqueuedAt <= MAX_QUEUE_AGE_MS)
    if (fresh.length === 0) queue.delete(sessionID)
    else queue.set(sessionID, fresh)
  }

  async function resolvePromptTarget(sessionID: string) {
    const messages = await Session.messages({ sessionID: SessionID.make(sessionID), limit: 100 })
    const lastUser = [...messages].reverse().find((message) => message.info.role === "user")
    if (!lastUser || lastUser.info.role !== "user") return {}
    return {
      agent: lastUser.info.agent,
      model: lastUser.info.model,
      variant: lastUser.info.model.variant,
    }
  }

  async function deliver(sessionID: string, entry: PendingEntry) {
    const client = sdk()
    const target = await resolvePromptTarget(sessionID)
    await client.session.promptAsync({
      sessionID,
      agent: target.agent,
      model: target.model,
      variant: target.variant,
      parts: [{ type: "text", text: entry.text }],
    })
    if (entry.pendingJobID) {
      WatcherState.markDelivered(entry.pendingJobID)
      Analytics.track({
        eventType: "watcher",
        eventName: "watcher.delivered",
        sessionId: sessionID,
        metadata: {
          jobID: entry.pendingJobID,
          queueWaitMs: Date.now() - entry.enqueuedAt,
          finding: entry.text,
          title: entry.title ?? null,
        },
      })
    }
  }

  async function fallback(entry: PendingEntry) {
    // Rate-limit per pendingJobID so a long-running session-fetch failure
    // doesn't spam dozens of OS notifications across watcher fires.
    const key = entry.pendingJobID ?? `anon:${entry.title ?? "watcher"}`
    const now = Date.now()
    const last = lastFallbackAt.get(key) ?? 0
    if (now - last < FALLBACK_RATE_LIMIT_MS) {
      log.debug("inject.fallback.rate-limited", { key, sinceLastMs: now - last })
      return
    }
    lastFallbackAt.set(key, now)
    await Notify.send({
      title: entry.title || "Finny watcher",
      body: entry.text.slice(0, 240),
    })
    if (entry.pendingJobID) {
      WatcherState.markNotified(entry.pendingJobID)
      Analytics.track({
        eventType: "watcher",
        eventName: "watcher.fallback_notified",
        metadata: {
          jobID: entry.pendingJobID,
          finding: entry.text,
          title: entry.title ?? null,
        },
      })
    }
  }

  export function formatTaskCompleted(input: { description: string; text: string }) {
    return [
      `[background task completed: ${input.description}]`,
      "",
      "<task_result>",
      input.text,
      "</task_result>",
    ].join("\n")
  }

  export function formatTaskBlocked(input: { description: string; reason: string }) {
    return [`[background task blocked: ${input.description}]`, "", input.reason].join("\n")
  }

  export function formatTaskFailed(input: { description: string; error: string }) {
    return [`[background task failed: ${input.description}]`, "", input.error].join("\n")
  }

  export async function flush(sessionID: string): Promise<void> {
    if (flushing.has(sessionID)) return
    flushing.add(sessionID)
    let delivering: PendingEntry | undefined
    try {
      dropExpired(sessionID)
      const pending = queue.get(sessionID)
      if (!pending?.length) return

      const resolved = await resolveSession(sessionID)
      if (resolved.kind === "error") {
        // Transient lookup failure — keep the queue intact and retry on the
        // next idle event. Don't fall back to OS notifications: the session
        // probably still exists, we just couldn't read it.
        log.warn("inject.flush.session-lookup-failed", { sessionID, err: String(resolved.err) })
        return
      }
      if (resolved.kind === "missing") {
        for (const entry of pending) await fallback(entry)
        queue.delete(sessionID)
        return
      }

      const status = await getStatus(sessionID)
      if (status.type !== "idle") return

      const current = queue.get(sessionID)
      // Peek the head entry; remove it only AFTER deliver() succeeds. If
      // deliver throws, the entry stays at the front and the next idle event
      // will retry it. Task-side injections (no pendingJobID) have no DB
      // backing for retryPending, so losing them on a transient deliver
      // failure would be unrecoverable.
      delivering = current?.[0]
      if (!current || !delivering) {
        queue.delete(sessionID)
        return
      }

      await deliver(sessionID, delivering)
      current.shift()
      if (current.length === 0) queue.delete(sessionID)
    } catch (err) {
      if (delivering?.pendingJobID) WatcherState.markDeliveryError(delivering.pendingJobID, String(err).slice(0, 250))
      log.warn("inject.flush.delivery-failed", { sessionID, err: String(err) })
    } finally {
      flushing.delete(sessionID)
    }
  }

  export async function post(sessionID: string, text: string, options?: { title?: string; pendingJobID?: string }) {
    ensureSubscription()
    const entry: PendingEntry = {
      text,
      enqueuedAt: Date.now(),
      title: options?.title,
      pendingJobID: options?.pendingJobID,
    }

    const resolved = await resolveSession(sessionID)
    if (resolved.kind === "missing") {
      await fallback(entry)
      return
    }
    if (resolved.kind === "error") {
      // Transient lookup failure — enqueue anyway so the next idle event
      // can retry delivery. Better to hold the finding than to fall back to
      // OS notifications on a momentary read error.
      log.warn("inject.post.session-lookup-failed", { sessionID, err: String(resolved.err) })
    }

    // Always queue first, then attempt a flush. The previous "deliver immediately
    // when idle" shortcut could re-order messages relative to entries already in
    // the queue (queued during a brief busy window). flush() handles idle vs
    // busy uniformly and preserves FIFO order.
    queueEntry(sessionID, entry)
    await flush(sessionID)
  }

  export async function retryPending(sessionID?: string) {
    ensureSubscription()
    const pending = WatcherState.listPending().filter((item) => !sessionID || item.parentSessionID === sessionID)
    for (const item of pending) {
      if (!item.pendingFinding) continue
      // Skip jobs that already have an in-memory queue entry — otherwise we
      // double-deliver: once from the fresh post(), once from this retry.
      if (hasQueuedJob(item.jobID)) continue
      await post(item.parentSessionID, item.pendingFinding, {
        pendingJobID: item.jobID,
        title: item.algorithmName ? `Watcher: ${item.algorithmName}` : "Finny watcher",
      })
    }
  }
}
