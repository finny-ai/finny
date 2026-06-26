import { describe, expect, test } from "bun:test"
import { usable, isOverflow } from "@/session/overflow"

function model(input: { context: number; output?: number; inputLimit?: number; id?: string; providerID?: string }) {
  return {
    id: input.id ?? "test-model",
    providerID: input.providerID ?? "test-provider",
    limit: {
      context: input.context,
      output: input.output ?? 8_192,
      ...(input.inputLimit ? { input: input.inputLimit } : {}),
    },
  } as any
}

function tokens(total: number) {
  return { total, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
}

describe("overflow ratio-based compaction", () => {
  test("defaults to 60% of the context window (1M model trips at ~600k)", () => {
    const result = usable({ cfg: {} as any, model: model({ context: 1_000_000 }) })
    expect(result).toBe(600_000)
  })

  test("scales per-model automatically (200k model trips at ~120k)", () => {
    const result = usable({ cfg: {} as any, model: model({ context: 200_000 }) })
    expect(result).toBe(120_000)
  })

  test("explicit ratio overrides the default", () => {
    const result = usable({ cfg: { compaction: { ratio: 0.5 } } as any, model: model({ context: 1_000_000 }) })
    expect(result).toBe(500_000)
  })

  test("per-model override wins over the global ratio", () => {
    const cfg = {
      compaction: { ratio: 0.6, ratio_overrides: { "acme/big": 0.3 } },
    } as any
    const result = usable({ cfg, model: model({ context: 1_000_000, id: "big", providerID: "acme" }) })
    expect(result).toBe(300_000)
  })

  test("ratio >= 1 disables the early cap (falls back to the hard usable limit)", () => {
    const capped = usable({ cfg: { compaction: { ratio: 0.6 } } as any, model: model({ context: 1_000_000 }) })
    const uncapped = usable({ cfg: { compaction: { ratio: 1 } } as any, model: model({ context: 1_000_000 }) })
    expect(uncapped).toBeGreaterThan(capped)
    // Hard limit is context minus the reserved output budget — well above the 60% cap.
    expect(uncapped).toBeGreaterThan(900_000)
  })

  test("ratio never raises the threshold above the hard usable limit", () => {
    // A tiny context window where 0.6 * context still exceeds context - output.
    const m = model({ context: 10_000, output: 8_000 })
    const result = usable({ cfg: {} as any, model: m })
    // hard = 10_000 - maxOutput(<=8000) <= 2_000; ratio cap = 6_000 -> min picks hard.
    expect(result).toBeLessThanOrEqual(2_000)
  })

  test("isOverflow trips at the ratio threshold, not the hard limit", () => {
    const m = model({ context: 1_000_000 })
    const cfg = {} as any
    expect(isOverflow({ cfg, tokens: tokens(599_999), model: m })).toBe(false)
    expect(isOverflow({ cfg, tokens: tokens(600_000), model: m })).toBe(true)
  })

  test("auto:false disables compaction entirely", () => {
    const m = model({ context: 1_000_000 })
    expect(isOverflow({ cfg: { compaction: { auto: false } } as any, tokens: tokens(999_999), model: m })).toBe(false)
  })
})
