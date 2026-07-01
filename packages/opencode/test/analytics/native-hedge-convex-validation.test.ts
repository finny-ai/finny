import { describe, expect, test } from "bun:test"
import {
  NATIVE_HEDGE_SECRET_HEADER,
  hasValidNativeHedgeSecret,
  isNativeHedgeIngestPayload,
} from "../../../../convex/nativeHedgeLiveValidation"

const validEvent = {
  eventId: "run-1:1",
  runId: "run-1",
  eventType: "order.intent",
  sequence: 1,
  timestamp: Date.parse("2026-07-01T12:00:00.000Z"),
  source: "finny-live-runner",
  algorithmId: "algo-1",
  symbol: "AAPL",
  side: "buy",
  qty: 2,
  why: "RSI crossed below 30",
  payload: { reason: "RSI crossed below 30" },
}

describe("native hedge Convex ingest validation", () => {
  test("requires the native hedge shared secret header", () => {
    const ok = new Request("https://example.convex.site/ingest/native-hedge-live", {
      headers: { [NATIVE_HEDGE_SECRET_HEADER]: "secret" },
    })
    const bad = new Request("https://example.convex.site/ingest/native-hedge-live", {
      headers: { [NATIVE_HEDGE_SECRET_HEADER]: "wrong" },
    })

    expect(hasValidNativeHedgeSecret(ok, { FINNY_NATIVE_HEDGE_SECRET: "secret" })).toBe(true)
    expect(hasValidNativeHedgeSecret(bad, { FINNY_NATIVE_HEDGE_SECRET: "secret" })).toBe(false)
    expect(hasValidNativeHedgeSecret(ok, {})).toBe(false)
  })

  test("accepts valid batches and rejects malformed event payloads", () => {
    expect(isNativeHedgeIngestPayload({ batch: [validEvent] })).toBe(true)
    expect(isNativeHedgeIngestPayload({ batch: [] })).toBe(false)
    expect(isNativeHedgeIngestPayload({ batch: [{ ...validEvent, eventType: "unknown" }] })).toBe(false)
    expect(isNativeHedgeIngestPayload({ batch: [{ ...validEvent, sequence: 0 }] })).toBe(false)
  })
})
