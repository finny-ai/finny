import { describe, expect, test } from "bun:test"
import { isSlug, isValidAlgoId, makeSlug, parseSlug, slugTimestamp } from "./schemas"

describe("datetime slug format", () => {
  test("makeSlug defaults to a D.M.HH.mm suffix", () => {
    const slug = makeSlug("spy-15m-mean-reversion", undefined)
    expect(slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
    expect(isSlug(slug)).toBe(true)
    const { humanName, shortId } = parseSlug(slug)
    expect(humanName).toBe("spy-15m-mean-reversion")
    expect(shortId).toMatch(/^\d{1,2}\.\d{1,2}\.\d{2}\.\d{2}$/)
  })

  test("slugTimestamp renders D.M.HH.mm", () => {
    expect(slugTimestamp(new Date(2026, 5, 10, 11, 9))).toBe("10.6.11.09")
    expect(slugTimestamp(new Date(2026, 0, 2, 0, 0))).toBe("2.1.00.00")
  })

  test("accepts the user-facing example", () => {
    expect(isSlug("spy-15m-mean-reversion.10.6.11.09")).toBe(true)
    expect(isValidAlgoId("spy-15m-mean-reversion.10.6.11.09")).toBe(true)
  })

  test("legacy hex slugs still resolve", () => {
    expect(isSlug("spy-15m-mean-reversion.10511656")).toBe(true)
    expect(isSlug("btc-mean-reversion-1h.a3f8c9e2")).toBe(true)
    expect(parseSlug("btc-mean-reversion-1h.a3f8c9e2").shortId).toBe("a3f8c9e2")
  })

  test("parseSlug splits at the first dot (datetime suffixes contain dots)", () => {
    const { humanName, shortId } = parseSlug("spy-15m-mean-reversion.10.6.11.09")
    expect(humanName).toBe("spy-15m-mean-reversion")
    expect(shortId).toBe("10.6.11.09")
  })

  test("rejects malformed suffixes", () => {
    expect(isSlug("spy-15m.10.6.11")).toBe(false) // missing minute
    expect(isSlug("spy-15m.banana")).toBe(false)
    expect(() => makeSlug("spy-15m", "nope")).toThrow("invalid slug suffix")
  })
})
