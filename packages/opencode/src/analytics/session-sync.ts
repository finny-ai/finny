import { GlobalBus } from "../bus/global"
import { ConvexSessions } from "../storage/convex/sessions"
import { ConvexMessages } from "../storage/convex/messages"
import { ConvexParts } from "../storage/convex/parts"
import { Session } from "../session"
import { Analytics } from "./tracker"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"

const log = Log.create({ service: "session-sync" })

// Buffer parts per-message until the message completes. We accumulate into a
// Map<partId, partRow> so streaming updates collapse to one final state per
// part — this is the whole point of the message-completion strategy: we pay
// one batch write per message instead of one per token.
const partBuffers = new Map<string, Map<string, PartRow>>()

// Track sessions we've already created in Convex this process. Avoids one
// extra mutation per message after the first.
const sessionCreated = new Set<string>()

let started = false

type PartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: any
}

export namespace SessionSync {
  export function start() {
    if (started) return
    if (!Analytics.isEnabled()) return
    started = true

    GlobalBus.on("event", (env) => {
      const payload = (env as any)?.payload
      if (!payload?.type) return

      // Buffer streaming part updates — never write them individually.
      if (payload.type === "message.part.updated") {
        const { sessionID, part, time } = payload.properties ?? {}
        const messageID = part?.messageID
        if (!messageID || !part?.id || !sessionID) return
        let bucket = partBuffers.get(messageID)
        if (!bucket) {
          bucket = new Map()
          partBuffers.set(messageID, bucket)
        }
        bucket.set(part.id, {
          id: part.id,
          message_id: messageID,
          session_id: sessionID,
          time_created: typeof time === "number" ? time : Date.now(),
          data: part,
        })
        return
      }

      // Drop part-removed events from the buffer so we don't ship stale parts.
      if (payload.type === "message.part.removed") {
        const { messageID, partID } = payload.properties ?? {}
        partBuffers.get(messageID)?.delete(partID)
        return
      }

      if (payload.type === "message.updated") {
        const { sessionID, info } = payload.properties ?? {}
        if (!sessionID || !info?.id) return
        const isComplete =
          info.role === "user" || (info.role === "assistant" && info.time?.completed != null)
        if (!isComplete) return
        void syncCompletedMessage(sessionID, info)
      }
    })

    log.info("session sync subscriber started")
  }
}

async function syncCompletedMessage(sessionID: string, info: any) {
  try {
    if (!sessionCreated.has(sessionID)) {
      sessionCreated.add(sessionID)
      try {
        const sess = await Session.get(sessionID as any)
        // The local SQLite session row has no user_id column (sessions are
        // single-user on the device); inject it here so Convex can index by
        // owner. Failure to resolve the device userId is non-fatal — the row
        // still gets created, just without ownership for that one session.
        const user_id = await DeviceProfile.userId().catch(() => undefined)
        // No upsert mutation server-side — try create, swallow duplicate errors.
        // Rare path (once per session per process), so the extra round-trip is fine.
        await ConvexSessions.create({ ...(Session.toRow(sess) as any), user_id }).catch((err) => {
          // Convex mutations re-throw on uniqueness violations; treat as a no-op.
          log.info("session row already exists or create failed", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      } catch (err) {
        log.warn("failed to load session for sync", { sessionID, error: err })
      }
    }

    await ConvexMessages.upsert({
      id: info.id,
      session_id: sessionID,
      time_created: info.time?.created ?? Date.now(),
      data: info,
    })

    const bucket = partBuffers.get(info.id)
    if (bucket && bucket.size > 0) {
      const parts = Array.from(bucket.values())
      partBuffers.delete(info.id)
      await ConvexParts.insertBatch(parts)
    }
  } catch (err) {
    log.warn("failed to sync message", {
      sessionID,
      messageID: info.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
