import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Telemetry } from "@/analytics/gate"
import { TelemetrySink } from "@/analytics/sink"

let tempDir: string
let originalSecret: string | undefined
let originalUrl: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-telemetry-sink-"))
  originalSecret = process.env.FINNY_TELEMETRY_SECRET
  originalUrl = process.env.FINNY_TELEMETRY_URL
  delete process.env.FINNY_TELEMETRY_SECRET
  delete process.env.FINNY_TELEMETRY_URL
  Telemetry._resetForTests()
  Telemetry._setForTests(true)
  TelemetrySink._resetForTests()
})

afterEach(async () => {
  if (originalSecret === undefined) delete process.env.FINNY_TELEMETRY_SECRET
  else process.env.FINNY_TELEMETRY_SECRET = originalSecret
  if (originalUrl === undefined) delete process.env.FINNY_TELEMETRY_URL
  else process.env.FINNY_TELEMETRY_URL = originalUrl
  Telemetry._resetForTests()
  TelemetrySink._resetForTests()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("TelemetrySink", () => {
  test("flushes without FINNY_TELEMETRY_SECRET and omits the secret header", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    TelemetrySink._setFetchForTests((async (input: any, init: any) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    TelemetrySink.enqueue({
      kind: "event",
      eventType: "test.event",
      payload: { foo: "bar" },
      time_created: Date.now(),
    })
    await TelemetrySink.flush()
    await TelemetrySink.drain()

    expect(capturedUrl).toBe("https://wry-mastiff-821.convex.site/ingest/telemetry")
    const headers = capturedInit?.headers as Record<string, string> | undefined
    expect(headers?.["x-finny-telemetry-secret"]).toBeUndefined()
    const body = JSON.parse(String(capturedInit?.body))
    expect(typeof body.deviceUserId).toBe("string")
    expect(body.deviceUserId.length).toBeGreaterThan(0)
    expect(body.batch).toHaveLength(1)
    expect(body.batch[0].eventType).toBe("test.event")
  })

  test("includes optional secret header when FINNY_TELEMETRY_SECRET is set", async () => {
    process.env.FINNY_TELEMETRY_SECRET = "debug-secret"

    let capturedInit: RequestInit | undefined
    TelemetrySink._setFetchForTests((async (_input: any, init: any) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    TelemetrySink.enqueue({
      kind: "event",
      eventType: "test.event",
      time_created: Date.now(),
    })
    await TelemetrySink.flush()
    await TelemetrySink.drain()

    const headers = capturedInit?.headers as Record<string, string> | undefined
    expect(headers?.["x-finny-telemetry-secret"]).toBe("debug-secret")
  })

  test("does not enqueue when the telemetry gate is off", async () => {
    Telemetry._setForTests(false)

    let called = false
    TelemetrySink._setFetchForTests((async () => {
      called = true
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    TelemetrySink.enqueue({
      kind: "event",
      eventType: "test.event",
      time_created: Date.now(),
    })
    await TelemetrySink.flush()

    expect(called).toBe(false)
  })
})
