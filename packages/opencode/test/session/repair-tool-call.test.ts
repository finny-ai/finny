import { describe, expect, test } from "bun:test"
import {
  escapeRawControlCharsInStrings,
  reconstructCharIndexedInput,
  repairQuestionToolInput,
  repairToolCallInput,
} from "../../src/session/repair-tool-call"

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

  test("repairs raw newlines inside string values (Unterminated string)", () => {
    // The exact failure from the transcript: a `task` batch call whose prompt
    // strings contained literal, unescaped newlines.
    const broken = '{"tasks": [{"prompt": "line one\nline two\nline three"}]}'
    expect(() => JSON.parse(broken)).toThrow()

    const repaired = repairToolCallInput(broken)
    expect(repaired).toBeDefined()
    const parsed = JSON.parse(repaired!)
    expect(parsed.tasks[0].prompt).toBe("line one\nline two\nline three")
  })

  test("repairs raw tabs and carriage returns inside string values", () => {
    const broken = '{"prompt": "a\tb\r\nc"}'
    const repaired = repairToolCallInput(broken)
    expect(repaired).toBeDefined()
    expect(JSON.parse(repaired!).prompt).toBe("a\tb\r\nc")
  })

  test("leaves already-valid JSON untouched (no repair needed)", () => {
    // Valid JSON should not be rewritten — repair only runs on parse failure.
    expect(repairToolCallInput('{"prompt": "already valid"}')).toBeUndefined()
  })
})

describe("repairQuestionToolInput", () => {
  test("fills missing question from header", () => {
    const broken = '{"questions": [{"header": "Pick a model", "options": [{"label": "gpt4"}]}]}'
    const repaired = repairQuestionToolInput(broken)
    expect(repaired).toBeDefined()
    const parsed = JSON.parse(repaired!)
    expect(parsed.questions[0].question).toBe("Pick a model")
  })

  test("does not modify when question is already present", () => {
    const valid = '{"questions": [{"question": "Pick a model", "header": "Model", "options": []}]}'
    expect(repairQuestionToolInput(valid)).toBeUndefined()
  })

  test("returns undefined for non-question tool input", () => {
    expect(repairQuestionToolInput('{"tasks": []}')).toBeUndefined()
  })

  test("returns undefined for unparseable input", () => {
    expect(repairQuestionToolInput("not json")).toBeUndefined()
  })
})

describe("escapeRawControlCharsInStrings", () => {
  test("escapes control chars inside strings but not structural whitespace", () => {
    const input = '{\n  "a": "x\ny"\n}'
    const escaped = escapeRawControlCharsInStrings(input)
    expect(escaped).toBeDefined()
    // The newline between "x" and "y" is inside a string → escaped.
    expect(escaped).toContain('"x\\ny"')
    // The structural newlines around the object are preserved as-is.
    expect(JSON.parse(escaped!).a).toBe("x\ny")
  })

  test("does not touch escaped quotes inside strings", () => {
    const input = '{"a": "he said \\"hi\\"\nbye"}'
    const escaped = escapeRawControlCharsInStrings(input)
    expect(JSON.parse(escaped!).a).toBe('he said "hi"\nbye')
  })

  test("returns undefined for non-string input", () => {
    expect(escapeRawControlCharsInStrings({ a: 1 })).toBeUndefined()
  })
})
