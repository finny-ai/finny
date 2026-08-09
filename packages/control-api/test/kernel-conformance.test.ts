import { describe, expect, test } from "bun:test"
import {
  ALGORITHM_LIFECYCLE_ACTIONS,
  ALGORITHM_LIFECYCLE_GUARDS,
  ALGORITHM_LIFECYCLE_STATES,
  ALGORITHM_LIFECYCLE_TRANSITIONS,
} from "../../algorithm/src/lifecycle"
import { AlgorithmIdSchema, AlgorithmSlugSchema, TenantIdSchema } from "../../algorithm/src/identity"
import { ContentDigestSchema } from "../../algorithm/src/records"
import { UtcTimestampSchema } from "../../algorithm/src/time"
import {
  CONTROL_V1_LIFECYCLE_ACTIONS,
  CONTROL_V1_LIFECYCLE_GUARDS,
  CONTROL_V1_LIFECYCLE_STATES,
  AlgorithmId,
  AlgorithmSlug,
  ContentDigest,
  TenantId,
  UtcTimestamp,
  controlV1LifecycleTransitions,
  strictDecode,
  type WireSchema,
} from "../src"

type SafeParseSchema = { readonly safeParse: (input: unknown) => { readonly success: boolean } }

function kernelAccepts(schema: SafeParseSchema, input: unknown): boolean {
  return schema.safeParse(input).success
}

function wireAccepts(schema: WireSchema, input: unknown): boolean {
  try {
    strictDecode(schema, input, "request")
    return true
  } catch {
    return false
  }
}

function expectSameValidity(kernel: SafeParseSchema, wire: WireSchema, values: readonly unknown[]) {
  for (const value of values) expect(wireAccepts(wire, value), JSON.stringify(value)).toBe(kernelAccepts(kernel, value))
}

describe("Control API V1 kernel conformance", () => {
  test("matches lifecycle states, actions, guards, and ordered transition guard tuples", () => {
    expect(CONTROL_V1_LIFECYCLE_STATES).toEqual(ALGORITHM_LIFECYCLE_STATES)
    expect(CONTROL_V1_LIFECYCLE_ACTIONS).toEqual(ALGORITHM_LIFECYCLE_ACTIONS)
    expect(CONTROL_V1_LIFECYCLE_GUARDS).toEqual(ALGORITHM_LIFECYCLE_GUARDS)
    expect(JSON.stringify(controlV1LifecycleTransitions)).toBe(
      JSON.stringify(
        ALGORITHM_LIFECYCLE_TRANSITIONS.map(({ from, to, action, guards }) => ({
          from,
          to,
          action,
          requiredEvidence: guards,
        })),
      ),
    )
  })

  test("matches kernel identifier and slug validity", () => {
    const identifiers = [
      "local",
      "org_123",
      "opaque id/with@chars",
      "x".repeat(255),
      "",
      " local",
      "local ",
      "x".repeat(256),
      "bad\u0000id",
      "\ud800",
      null,
      1,
    ]
    expectSameValidity(TenantIdSchema, TenantId, identifiers)
    expectSameValidity(AlgorithmIdSchema, AlgorithmId, identifiers)
    expectSameValidity(AlgorithmSlugSchema, AlgorithmSlug, [
      "mean-reversion",
      "mean-reversion.10.a3f8",
      "a".repeat(128),
      "",
      "Mean-Reversion",
      "mean_reversion",
      "mean.foo-bar",
      "a".repeat(129),
      null,
    ])
  })

  test("matches kernel UTC timestamp and content-digest validity", () => {
    expectSameValidity(UtcTimestampSchema, UtcTimestamp, [
      "0000-01-01T00:00:00Z",
      "2024-02-29T23:59:59.123456789Z",
      "2026-08-08T20:00:00.000Z",
      "2023-02-29T00:00:00Z",
      "2026-02-30T12:00:00Z",
      "2026-08-08T20:00Z",
      "2026-08-08T20:00:00-04:00",
      "2026-08-08T20:00:00.1234567890Z",
      null,
    ])
    expectSameValidity(ContentDigestSchema, ContentDigest, [
      `sha256:${"a".repeat(64)}`,
      `sha256:${"A".repeat(64)}`,
      "a".repeat(64),
      `sha256:${"a".repeat(63)}`,
      null,
    ])
  })
})
