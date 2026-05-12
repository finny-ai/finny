import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { Server } from "../server/server"
import { Notify } from "./notify"
import { Log } from "../util/log"
import { WatcherState } from "./watcher-state"
import { Analytics } from "@/analytics/tracker"

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
  // Track session status locally from bus events instead of querying
  // `SessionStatus.get`, which builds an isolated runtime+InstanceState
  // separate from the app runtime and would always read "idle".
  // Unknown sessions default to idle (matches SessionStatus.get's own default).
  const sessionStatus = new Map<string, SessionStatus.Info>()
  let unsubscribe: (() => void) | undefined

  function sdk() {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      return Server.Default().app.fetch(request)
    }) as typeof globalThis.fetch
    return createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
  }

  function ensureSubscription() {
    if (unsubscribe) return
    unsubscribe = Bus.subscribe(SessionStatus.Event.Status, (event) => {
      const { sessionID, status } = event.properties
      // Keep the local status map in sync with every event so `flush` can read
      // it without needing a runtime.
      if (status.type === "idle") sessionStatus.delete(sessionID)
      else sessionStatus.set(sessionID, status)

      if (status.type !== "idle") return
      void flush(sessionID).catch((err) => {
        log.warn("inject.flush.failed", { sessionID, err: String(err) })
      })
      void retryPending(sessionID).catch((err) => {
        log.warn("inject.retry-pending.failed", { sessionID, err: String(err) })
      })
    })
  }

  function getStatus(sessionID: string): SessionStatus.Info {
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

      const session = await Session.get(SessionID.make(sessionID)).catch(() => undefined)
      if (!session) {
        for (const entry of pending) await fallback(entry)
        queue.delete(sessionID)
        return
      }

      const status = getStatus(sessionID)
      if (status.type !== "idle") return

      const current = queue.get(sessionID)
      delivering = current?.shift()
      if (!delivering) {
        queue.delete(sessionID)
        return
      }
      if (current && current.length === 0) queue.delete(sessionID)
      else if (current) queue.set(sessionID, current)

      await deliver(sessionID, delivering)
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

    const session = await Session.get(SessionID.make(sessionID)).catch(() => undefined)
    if (!session) {
      await fallback(entry)
      return
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
