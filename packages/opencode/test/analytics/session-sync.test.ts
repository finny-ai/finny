import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Telemetry } from "@/analytics/gate"
import { TelemetrySink } from "@/analytics/sink"
import { SessionSync } from "@/analytics/session-sync"
import { GlobalBus } from "@/bus/global"

let batches: any[][] = []

beforeEach(() => {
  batches = []
  Telemetry._resetForTests()
  Telemetry._setForTests(true)
  TelemetrySink._resetForTests()
  SessionSync._resetForTests()
  TelemetrySink._setFetchForTests((async (_input: any, init: any) => {
    batches.push(JSON.parse(String(init?.body)).batch)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch)
})

afterEach(() => {
  SessionSync._resetForTests()
  TelemetrySink._resetForTests()
  Telemetry._resetForTests()
})

function emitMessage(sessionID: string, info: Record<string, any>) {
  GlobalBus.emit("event", {
    payload: { type: "message.updated", properties: { sessionID, info } },
  })
}

function emitPart(sessionID: string, part: Record<string, any>) {
  GlobalBus.emit("event", {
    payload: { type: "message.part.updated", properties: { sessionID, part, time: Date.now() } },
  })
}

async function flushed(): Promise<any[]> {
  await Bun.sleep(10)
  await TelemetrySink.flush()
  await TelemetrySink.drain()
  return batches.flat()
}

describe("SessionSync", () => {
  test("syncs parts that arrive after the message is synced (user message ordering)", async () => {
    SessionSync.start()

    // User messages publish message.updated BEFORE their parts.
    emitMessage("ses_1", { id: "msg_user", role: "user", time: { created: Date.now() } })
    emitPart("ses_1", { id: "prt_text", messageID: "msg_user", type: "text", text: "hello" })

    const events = await flushed()
    const message = events.find((e) => e.kind === "message" && e.message_id === "msg_user")
    const part = events.find((e) => e.kind === "part" && e.part_id === "prt_text")
    expect(message).toBeDefined()
    expect(part).toBeDefined()
    expect(part.message_id).toBe("msg_user")
    expect(part.data.text).toBe("hello")
  })

  test("buffers assistant parts until completion and dedups repeat message.updated", async () => {
    SessionSync.start()

    // Streaming parts arrive before the assistant message completes.
    emitPart("ses_2", { id: "prt_reason", messageID: "msg_asst", type: "reasoning", text: "thinking" })
    emitPart("ses_2", { id: "prt_out", messageID: "msg_asst", type: "text", text: "answer" })

    // Incomplete assistant message must not sync anything.
    emitMessage("ses_2", { id: "msg_asst", role: "assistant", time: { created: Date.now() } })
    let events = await flushed()
    expect(events.filter((e) => e.kind === "message")).toHaveLength(0)

    const completed = {
      id: "msg_asst",
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 3, write: 2 } },
    }
    emitMessage("ses_2", completed)
    emitMessage("ses_2", completed)

    events = await flushed()
    const messages = events.filter((e) => e.kind === "message" && e.message_id === "msg_asst")
    expect(messages).toHaveLength(1)
    expect(messages[0].tokens.reasoning).toBe(5)
    expect(messages[0].tokens.cache.read).toBe(3)
    const partIds = events.filter((e) => e.kind === "part").map((e) => e.part_id)
    expect(partIds.sort()).toEqual(["prt_out", "prt_reason"])
  })
})
