import { describe, expect, test } from "bun:test"
import { buildAlgorithmListPayload } from "../../src/tool/algorithm-list"
import { countUniqueAlgorithms } from "../../src/tool/algorithm-save"
import type { Algorithm } from "../../src/algorithm"

let nextAlgorithmId = 1
function row(over: Partial<Algorithm.Info>): Algorithm.Info {
  return {
    algorithmId: over.algorithmId ?? `id-${nextAlgorithmId++}`,
    userId: "u1",
    name: over.name ?? "anon",
    code: "",
    language: over.language ?? "python",
    version: over.version ?? 1,
    status: over.status ?? "draft",
    description: over.description,
    config: over.config,
    backtestCode: over.backtestCode,
    time_created: over.time_created ?? 0,
    time_updated: over.time_updated ?? 0,
    ...over,
  }
}

describe("buildAlgorithmListPayload", () => {
  test("empty input still returns a JSON-shaped payload", () => {
    const p = buildAlgorithmListPayload([], "free")
    expect(p).toEqual({ count: 0, capacity: null, remaining: null, tier: "free", algorithms: [] })
  })

  test("collapses duplicate-name rows to the highest version", () => {
    const algos = [
      row({ name: "orb", version: 1, time_updated: 100 }),
      row({ name: "orb", version: 7, time_updated: 200 }),
      row({ name: "capital", version: 4, time_updated: 150 }),
      row({ name: "capital", version: 1, time_updated: 50 }),
    ]
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.count).toBe(2)
    expect(p.algorithms.map((a) => `${a.name}@${a.version}`)).toEqual(["orb@7", "capital@4"])
  })

  test("ties on version are broken by time_updated (most recent wins)", () => {
    const algos = [
      row({ name: "x", version: 3, time_updated: 100, algorithmId: "old" }),
      row({ name: "x", version: 3, time_updated: 500, algorithmId: "new" }),
      row({ name: "x", version: 3, time_updated: 200, algorithmId: "mid" }),
    ]
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.count).toBe(1)
    // The Map collapses to a single entry; verify it's the most recently updated.
    expect(p.algorithms[0].updated).toBe(new Date(500).toISOString())
  })

  test("local capacity is unlimited for every tier", () => {
    const algos = [
      row({ name: "a", version: 1 }),
      row({ name: "b", version: 1 }),
      row({ name: "c", version: 1 }),
    ]
    for (const tier of ["free", "lite", "pro"] as const) {
      const p = buildAlgorithmListPayload(algos, tier)
      expect(p.capacity).toBeNull()
      expect(p.remaining).toBeNull()
    }
  })

  test("does not report capacity exhaustion as algorithm count grows", () => {
    const algos = Array.from({ length: 8 }, (_, i) => row({ name: `n${i}`, version: 1 }))
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.count).toBe(8)
    expect(p.capacity).toBeNull()
    expect(p.remaining).toBeNull()
  })

  test("lite tier also reports null capacity and remaining", () => {
    const p = buildAlgorithmListPayload([row({ name: "a", version: 1 })], "lite")
    expect(p.capacity).toBeNull()
    expect(p.remaining).toBeNull()
  })

  test("payload is JSON-serializable without losing capacity/remaining", () => {
    const p = buildAlgorithmListPayload([], "free")
    const round = JSON.parse(JSON.stringify(p))
    expect(round.capacity).toBeNull()
    expect(round.remaining).toBeNull()
  })

  test("orders by time_updated desc", () => {
    const algos = [
      row({ name: "old", version: 1, time_updated: 100 }),
      row({ name: "new", version: 1, time_updated: 300 }),
      row({ name: "mid", version: 1, time_updated: 200 }),
    ]
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.algorithms.map((a) => a.name)).toEqual(["new", "mid", "old"])
  })
})

describe("countUniqueAlgorithms", () => {
  test("collapses duplicate-name rows", () => {
    const algos = [
      { name: "orb" },
      { name: "orb" },
      { name: "capital" },
      { name: "capital" },
      { name: "rng" },
    ]
    expect(countUniqueAlgorithms(algos)).toBe(3)
  })

  test("empty input returns 0", () => {
    expect(countUniqueAlgorithms([])).toBe(0)
  })

  test("all distinct names returns full length", () => {
    expect(countUniqueAlgorithms([{ name: "a" }, { name: "b" }, { name: "c" }])).toBe(3)
  })

  test("counts distinct names independently of local save policy", () => {
    const algos = ["a", "b", "c", "d", "e"].map((name) => ({ name }))
    expect(countUniqueAlgorithms(algos)).toBe(5)
  })

  test("duplicate-name rows collapse to their visible unique count", () => {
    // 4 unique names with one duplicate → 4, not 5.
    // This is the orphan-row scenario from the issue this PR fixes.
    const algos = [{ name: "a" }, { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]
    expect(countUniqueAlgorithms(algos)).toBe(4)
  })
})
