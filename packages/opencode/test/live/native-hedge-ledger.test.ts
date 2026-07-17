import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { NativeHedgeLedger } from "../../src/live/native-hedge-ledger"

let tempDir: string
let originalFlag: string | undefined
let originalUrl: string | undefined
let originalSecret: string | undefined
let originalSpoolDir: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-native-hedge-ledger-"))
  originalFlag = process.env.FINNY_AI_NATIVE_HEDGE
  originalUrl = process.env.FINNY_NATIVE_HEDGE_CONVEX_URL
  originalSecret = process.env.FINNY_NATIVE_HEDGE_SECRET
  originalSpoolDir = process.env.FINNY_NATIVE_HEDGE_SPOOL_DIR
  process.env.FINNY_AI_NATIVE_HEDGE = "1"
  process.env.FINNY_NATIVE_HEDGE_CONVEX_URL = "https://example.convex.site/ingest/native-hedge-live"
  process.env.FINNY_NATIVE_HEDGE_SECRET = "test-secret"
  process.env.FINNY_NATIVE_HEDGE_SPOOL_DIR = tempDir
  NativeHedgeLedger._resetForTests()
})

afterEach(async () => {
  if (originalFlag === undefined) delete process.env.FINNY_AI_NATIVE_HEDGE
  else process.env.FINNY_AI_NATIVE_HEDGE = originalFlag
  if (originalUrl === undefined) delete process.env.FINNY_NATIVE_HEDGE_CONVEX_URL
  else process.env.FINNY_NATIVE_HEDGE_CONVEX_URL = originalUrl
  if (originalSecret === undefined) delete process.env.FINNY_NATIVE_HEDGE_SECRET
  else process.env.FINNY_NATIVE_HEDGE_SECRET = originalSecret
  if (originalSpoolDir === undefined) delete process.env.FINNY_NATIVE_HEDGE_SPOOL_DIR
  else process.env.FINNY_NATIVE_HEDGE_SPOOL_DIR = originalSpoolDir
  NativeHedgeLedger._resetForTests()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("NativeHedgeLedger", () => {
  test("requires the explicit AI native hedge flag and sink config", () => {
    expect(NativeHedgeLedger.flagEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(NativeHedgeLedger.flagEnabled({ FINNY_AI_NATIVE_HEDGE: "1" } as NodeJS.ProcessEnv)).toBe(true)
    expect(
      NativeHedgeLedger.enabled({
        FINNY_AI_NATIVE_HEDGE: "1",
        FINNY_NATIVE_HEDGE_SECRET: "secret",
      } as NodeJS.ProcessEnv),
    ).toBe(true)
    expect(
      NativeHedgeLedger.enabled({
        FINNY_AI_NATIVE_HEDGE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false)
    expect(NativeHedgeLedger.disabledReason({ FINNY_AI_NATIVE_HEDGE: "1" } as NodeJS.ProcessEnv)).toBe("FINNY_NATIVE_HEDGE_SECRET is empty")
    expect(NativeHedgeLedger.spoolPathForRun("run/1", { FINNY_NATIVE_HEDGE_SPOOL_DIR: "/tmp/native" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/native/run_1.jsonl",
    )
  })

  test("spools locally before posting with the native hedge secret header", async () => {
    let capturedUrl = ""
    let capturedHeaders: HeadersInit | undefined
    let capturedBody: any
    let spoolExistedBeforePost = false

    NativeHedgeLedger._setFetchForTests((async (input: any, init: any) => {
      capturedUrl = String(input)
      capturedHeaders = init.headers
      capturedBody = JSON.parse(String(init.body))
      const spool = await fs.readFile(NativeHedgeLedger._spoolPathForTests("run-1"), "utf8")
      spoolExistedBeforePost = spool.includes("\"eventType\":\"order.intent\"")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    const event = NativeHedgeLedger.record({
      runId: "run-1",
      eventType: "order.intent",
      algorithmId: "algo-1",
      symbol: "AAPL",
      side: "buy",
      qty: 2,
      why: "RSI crossed below 30",
      features: { rsi: 29.4 },
    })

    expect(event?.eventId).toBe("run-1:1")
    await NativeHedgeLedger.drain()

    expect(capturedUrl).toBe("https://example.convex.site/ingest/native-hedge-live")
    expect((capturedHeaders as Record<string, string>)["x-finny-native-hedge-secret"]).toBe("test-secret")
    expect(capturedBody.batch).toHaveLength(1)
    expect(capturedBody.batch[0].why).toBe("RSI crossed below 30")
    expect(spoolExistedBeforePost).toBe(true)
  })

  test("drain flushes more than one batch", async () => {
    const batchSizes: number[] = []
    NativeHedgeLedger._setFetchForTests((async (_input: any, init: any) => {
      batchSizes.push(JSON.parse(String(init.body)).batch.length)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    for (let i = 0; i < 55; i++) {
      NativeHedgeLedger.record({
        runId: "run-many",
        eventType: "log",
        payload: { i },
      })
    }
    await NativeHedgeLedger.drain()

    expect(batchSizes).toEqual([50, 5])
    expect(NativeHedgeLedger._bufferLengthForTests()).toBe(0)
  })

  test("does not retry permanently rejected batches forever", async () => {
    let calls = 0
    NativeHedgeLedger._setFetchForTests((async () => {
      calls++
      return new Response(JSON.stringify({ ok: false }), { status: 403 })
    }) as unknown as typeof fetch)

    NativeHedgeLedger.record({
      runId: "run-rejected",
      eventType: "log",
      payload: { message: "bad secret" },
    })
    await NativeHedgeLedger.drain()

    expect(calls).toBe(1)
    expect(NativeHedgeLedger._bufferLengthForTests()).toBe(0)
  })
})
