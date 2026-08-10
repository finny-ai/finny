import { describe, expect, test } from "bun:test"
import { UtcTimestampSchema } from "./time"

describe("UTC timestamp", () => {
  test("accepts semantically valid UTC timestamps", () => {
    for (const valid of [
      "0000-02-29T00:00:00Z",
      "2000-02-29T23:59:59Z",
      "2024-02-29T23:59:59.1Z",
      "2026-08-08T20:00:00.123456789Z",
    ]) {
      expect(String(UtcTimestampSchema.parse(valid))).toBe(valid)
    }
  })

  test("rejects impossible calendar dates and times", () => {
    for (const invalid of [
      "1900-02-29T00:00:00Z",
      "2023-02-29T00:00:00Z",
      "2026-02-30T12:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-00-01T12:00:00Z",
      "2026-13-01T12:00:00Z",
      "2026-01-00T12:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T23:60:00Z",
      "2026-01-01T23:59:60Z",
    ]) {
      expect(UtcTimestampSchema.safeParse(invalid).success).toBe(false)
    }
  })

  test("requires canonical Z form, seconds, and at most nine fractional digits", () => {
    for (const invalid of [
      "2026-08-08T20:00Z",
      "2026-08-08 20:00:00Z",
      "2026-08-08T20:00:00z",
      "2026-08-08T20:00:00+00:00",
      "2026-08-08T20:00:00-04:00",
      "2026-08-08T20:00:00.Z",
      "2026-08-08T20:00:00.1234567890Z",
    ]) {
      expect(UtcTimestampSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
