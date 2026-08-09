import { describe, expect, test } from "bun:test"
import {
  AlgorithmIdSchema,
  AlgorithmSlugSchema,
  AlgorithmVersionRefSchema,
  AlgorithmVersionSchema,
  InvalidExactAlgorithmVersionRefError,
  TenantIdSchema,
  formatAlgorithmVersionRef,
  parseAlgorithmVersionRef,
} from "./identity"

describe("algorithm identity", () => {
  test("accepts bounded tenant IDs and rejects whitespace or ASCII controls", () => {
    expect(String(TenantIdSchema.parse("org_123"))).toBe("org_123")
    expect(String(TenantIdSchema.parse("a".repeat(255)))).toHaveLength(255)
    for (const invalid of [
      "",
      " org_123",
      "org_123 ",
      `org\u0000bad`,
      `org\nbad`,
      `org\u007fbad`,
      "\ud800",
      "a".repeat(256),
    ]) {
      expect(TenantIdSchema.safeParse(invalid).success).toBe(false)
    }
  })

  test("accepts existing UUID algorithm IDs without generating them", () => {
    expect(String(AlgorithmIdSchema.parse("b9abdd1a-3f0c-428c-ad5d-eb2a4bd7ca95"))).toBe(
      "b9abdd1a-3f0c-428c-ad5d-eb2a4bd7ca95",
    )
  })

  test("accepts current path-safe human aliases", () => {
    expect(String(AlgorithmSlugSchema.parse("spy-mean-reversion.10.6.11.09.a3f8c9e2"))).toBe(
      "spy-mean-reversion.10.6.11.09.a3f8c9e2",
    )
    for (const invalid of ["../spy", "SPY", "spy/reversion", "spy--reversion", "spy_reversion", "spy.foo-bar", " spy"])
      expect(AlgorithmSlugSchema.safeParse(invalid).success).toBe(false)
    expect(String(AlgorithmSlugSchema.parse("a".repeat(128)))).toHaveLength(128)
    expect(AlgorithmSlugSchema.safeParse("a".repeat(129)).success).toBe(false)
  })

  test("requires positive safe-integer versions", () => {
    expect(Number(AlgorithmVersionSchema.parse(1))).toBe(1)
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(AlgorithmVersionSchema.safeParse(invalid).success).toBe(false)
  })

  test("round-trips the canonical exact reference", () => {
    const ref = AlgorithmVersionRefSchema.parse({ algorithmId: "algo/opaque@id", version: 12 })
    const formatted = formatAlgorithmVersionRef(ref)
    expect(formatted).toBe("algo:algo%2Fopaque%40id@v12")
    expect(parseAlgorithmVersionRef(formatted)).toEqual(ref)
  })

  test("rejects moving, digest, unversioned, and non-canonical refs", () => {
    for (const invalid of [
      "algo:example",
      "algo:example@latest",
      "algo:example@qualified",
      "algo:example@paper",
      "algo:example@live",
      "algo:example@sha:0123",
      "algo:example@v0",
      "algo:example@v01",
      "algo:algo%2fopaque@v1",
    ]) {
      expect(() => parseAlgorithmVersionRef(invalid)).toThrow(InvalidExactAlgorithmVersionRefError)
    }
  })
})
