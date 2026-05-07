import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { Server } from "../server/server"
import { Notify } from "./notify"
import { Log } from "../util/log"

export namespace Inject {
  const log = Log.create({ service: "cron.inject" })
  const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000

  type PendingEntry = {
    text: string
    enqueuedAt: number
    title?: string
  }

  const queue = new Map<string, PendingEntry[]>()
  const flushing = new Set<string>()
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
      if (event.properties.status.type !== "idle") return
      void flush(event.properties.sessionID).catch((err) => {
        log.warn("inject.flush.failed", { sessionID: event.properties.sessionID, err: String(err) })
      })
    })
  }

  function queueEntry(sessionID: string, entry: PendingEntry) {
    const existing = queue.get(sessionID) ?? []
    existing.push(entry)
    queue.set(sessionID, existing)
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
  }

  async function fallback(entry: PendingEntry) {
    await Notify.send({
      title: entry.title || "Finny watcher",
      body: entry.text.slice(0, 240),
    })
  }

  export async function flush(sessionID: string): Promise<void> {
    if (flushing.has(sessionID)) return
    flushing.add(sessionID)
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

      const status = await SessionStatus.get(SessionID.make(sessionID))
      if (status.type !== "idle") return

      const current = queue.get(sessionID)
      const next = current?.shift()
      if (!next) {
        queue.delete(sessionID)
        return
      }
      if (current && current.length === 0) queue.delete(sessionID)
      else if (current) queue.set(sessionID, current)

      await deliver(sessionID, next)
    } catch (err) {
      log.warn("inject.flush.delivery-failed", { sessionID, err: String(err) })
    } finally {
      flushing.delete(sessionID)
    }
  }

  export async function post(sessionID: string, text: string, options?: { title?: string }) {
    ensureSubscription()
    const entry: PendingEntry = {
      text,
      enqueuedAt: Date.now(),
      title: options?.title,
    }

    const session = await Session.get(SessionID.make(sessionID)).catch(() => undefined)
    if (!session) {
      await fallback(entry)
      return
    }

    const status = await SessionStatus.get(SessionID.make(sessionID))
    if (status.type === "idle") {
      try {
        await deliver(sessionID, entry)
        return
      } catch (err) {
        log.warn("inject.post.immediate-failed", { sessionID, err: String(err) })
      }
    }

    queueEntry(sessionID, entry)
  }
}
