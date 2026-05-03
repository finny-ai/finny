import { describe, expect, test } from "bun:test"
import { buildAlgorithmListPayload } from "../../src/tool/algorithm-list"
import { countUniqueAlgorithms } from "../../src/tool/algorithm-save"
import type { Algorithm } from "../../src/algorithm"

function row(over: Partial<Algorithm.Info>): Algorithm.Info {
  return {
    algorithmId: over.algorithmId ?? `id-${Math.random()}`,
    userId: "u1",
    name: over.name ?? "anon",
    code: "",
    language: over.language ?? "python",
    version: over.version ?? 1,
    status: over.status ?? "draft",
    description: over.description,
    config: over.config,
    backtestCode: over.backtestCode,
    localPath: over.localPath,
    time_created: over.time_created ?? 0,
    time_updated: over.time_updated ?? 0,
    ...over,
  }
}

describe("buildAlgorithmListPayload", () => {
  test("empty input still returns a JSON-shaped payload", () => {
    const p = buildAlgorithmListPayload([], "free")
    expect(p).toEqual({ count: 0, capacity: 5, remaining: 5, tier: "free", algorithms: [] })
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

  test("free tier reports remaining slots", () => {
    const algos = [
      row({ name: "a", version: 1 }),
      row({ name: "b", version: 1 }),
      row({ name: "c", version: 1 }),
    ]
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.capacity).toBe(5)
    expect(p.remaining).toBe(2)
  })

  test("clamps remaining to 0 when over cap", () => {
    const algos = Array.from({ length: 8 }, (_, i) => row({ name: `n${i}`, version: 1 }))
    const p = buildAlgorithmListPayload(algos, "free")
    expect(p.remaining).toBe(0)
  })

  test("pro (unlimited) tier reports null capacity and remaining", () => {
    const p = buildAlgorithmListPayload([row({ name: "a", version: 1 })], "pro")
    expect(p.capacity).toBeNull()
    expect(p.remaining).toBeNull()
  })

  test("payload is JSON-serializable without losing capacity/remaining", () => {
    const p = buildAlgorithmListPayload([], "pro")
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

  test("matches the cap when uniqueCount === cap (would block a new save)", () => {
    // 5 distinct names → on free tier this equals SAVE_CAP and blocks new saves.
    // The block decision lives in the tool itself; here we verify the
    // count returns the value that decision keys on.
    const algos = ["a", "b", "c", "d", "e"].map((name) => ({ name }))
    expect(countUniqueAlgorithms(algos)).toBe(5)
  })

  test("duplicate-name rows do NOT push uniqueCount over cap", () => {
    // 4 unique names with one duplicate → 4, not 5.
    // This is the orphan-row scenario from the issue this PR fixes.
    const algos = [{ name: "a" }, { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]
    expect(countUniqueAlgorithms(algos)).toBe(4)
  })
})
