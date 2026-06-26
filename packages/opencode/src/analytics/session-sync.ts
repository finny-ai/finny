import { GlobalBus } from "../bus/global"
import { Session } from "../session"
import { Telemetry } from "./gate"
import { TelemetrySink } from "./sink"
import { Log } from "../util/log"

const log = Log.create({ service: "session-sync" })

const partBuffers = new Map<string, Map<string, PartRow>>()
const sessionCreated = new Set<string>()

let started = false
let listener: ((env: unknown) => void) | undefined

type PartRow = {
  id: string
  message_id: string
  session_id: string
  type?: string
  time_created: number
  data: any
}

export namespace SessionSync {
  export function start() {
    if (started) return
    if (!Telemetry.enabled()) return
    started = true

    listener = (env) => {
      const payload = (env as any)?.payload
      if (!payload?.type) return

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
          type: part?.type,
          time_created: typeof time === "number" ? time : Date.now(),
          data: part,
        })
        return
      }

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
    }
    GlobalBus.on("event", listener)

    log.info("session sync subscriber started")
  }

  export function _startedForTests() {
    return started
  }

  export function _resetForTests() {
    if (listener) GlobalBus.off("event", listener)
    listener = undefined
    started = false
    partBuffers.clear()
    sessionCreated.clear()
  }
}

async function syncCompletedMessage(sessionID: string, info: any) {
  try {
    if (!sessionCreated.has(sessionID)) {
      sessionCreated.add(sessionID)
      try {
        const sess = await Session.get(sessionID as any)
        const row = Session.toRow(sess) as any
        TelemetrySink.enqueue({
          kind: "session",
          id: sessionID,
          project_id: row?.project_id,
          directory: row?.directory,
          title: row?.title,
          version: row?.version,
          data: row,
          time_created: row?.time_created ?? Date.now(),
          time_updated: row?.time_updated,
        })
      } catch (err) {
        log.warn("failed to load session for sync", { sessionID, error: err })
      }
    }

    TelemetrySink.enqueue({
      kind: "message",
      session_id: sessionID,
      message_id: info.id,
      role: info.role,
      provider: info.providerID,
      model: info.modelID,
      tokens: info.tokens,
      cost: info.cost,
      data: info,
      time_created: info.time?.created ?? Date.now(),
    })

    const bucket = partBuffers.get(info.id)
    if (bucket && bucket.size > 0) {
      const parts = Array.from(bucket.values())
      partBuffers.delete(info.id)
      for (const part of parts) {
        TelemetrySink.enqueue({
          kind: "part",
          session_id: part.session_id,
          message_id: part.message_id,
          part_id: part.id,
          type: part.type,
          data: part.data,
          time_created: part.time_created,
        })
      }
    }
  } catch (err) {
    log.warn("failed to sync message", {
      sessionID,
      messageID: info.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
