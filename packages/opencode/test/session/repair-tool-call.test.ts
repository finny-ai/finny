import { describe, expect, test } from "bun:test"
import { reconstructCharIndexedInput, repairToolCallInput } from "../../src/session/repair-tool-call"

describe("reconstructCharIndexedInput", () => {
  test("rebuilds the original string from a character-indexed object", () => {
    const original = '{"name":"spy-15m-mean-reversion"}'
    const charIndexed: Record<string, string> = {}
    for (let i = 0; i < original.length; i++) charIndexed[String(i)] = original[i]!
    expect(reconstructCharIndexedInput(charIndexed)).toBe(original)
  })

  test("rebuilds from a JSON string of a character-indexed object", () => {
    const original = '{"a":1}'
    const charIndexed: Record<string, string> = {}
    for (let i = 0; i < original.length; i++) charIndexed[String(i)] = original[i]!
    expect(reconstructCharIndexedInput(JSON.stringify(charIndexed))).toBe(original)
  })

  test("returns undefined for a normal object", () => {
    expect(reconstructCharIndexedInput({ name: "spy", interval: "15m" })).toBeUndefined()
  })

  test("returns undefined when indices have gaps", () => {
    expect(reconstructCharIndexedInput({ "0": "a", "2": "b" })).toBeUndefined()
  })

  test("returns undefined for multi-character values", () => {
    expect(reconstructCharIndexedInput({ "0": "ab", "1": "c" })).toBeUndefined()
  })
})

describe("repairToolCallInput", () => {
  test("repairs a malformed char-indexed save payload into valid JSON object text", () => {
    // The exact failure shape from the transcript: a stringified save arg that
    // arrived spread into character-indexed fields [0={, 1=", 2=n, ...].
    const original = '{"name":"spy-15m-mean-reversion","saveMode":"new"}'
    const charIndexed: Record<string, string> = {}
    for (let i = 0; i < original.length; i++) charIndexed[String(i)] = original[i]!

    const repaired = repairToolCallInput(charIndexed)
    expect(repaired).toBe(original)
    const parsed = JSON.parse(repaired!)
    expect(parsed.name).toBe("spy-15m-mean-reversion")
    expect(parsed.saveMode).toBe("new")
  })

  test("returns undefined when the payload is not recoverable (clean retry path)", () => {
    expect(repairToolCallInput({ foo: "bar" })).toBeUndefined()
    expect(repairToolCallInput("not json at all")).toBeUndefined()
    // char-indexed but the reconstructed text is not a JSON object
    expect(repairToolCallInput({ "0": "h", "1": "i" })).toBeUndefined()
  })
})
