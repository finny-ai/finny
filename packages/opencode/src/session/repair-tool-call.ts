/**
 * Tool-call input repair.
 *
 * Some models occasionally emit a tool call whose arguments are a JSON string
 * that was spread character-by-character into an object with integer keys, e.g.
 *
 *   { "0": "{", "1": "\"", "2": "n", "3": "a", "4": "m", "5": "e", ... }
 *
 * The provider/SDK then fails to validate this against the tool's input schema.
 * Before the failure is turned into an `invalid` tool routing (which the user
 * sees as a confusing "unavailable tool 'invalid'" error), we try to
 * reconstruct the original JSON string and recover a well-formed object.
 *
 * A second, more common failure comes from weaker models emitting multi-line
 * string values (e.g. long subagent prompts for the `task` tool) with raw,
 * unescaped newlines inside the JSON. JSON forbids literal control characters
 * inside string literals, so `JSON.parse` fails with "Unterminated string".
 * We repair those by escaping the raw control characters that appear inside
 * string literals and re-parsing.
 */

/**
 * If `input` is (or decodes to) an object whose keys are the contiguous integer
 * sequence 0..n-1 and whose values are all single characters, join the
 * characters back into the original string. Returns that string, or `undefined`
 * if the shape does not match.
 */
export function reconstructCharIndexedInput(input: unknown): string | undefined {
  let obj: unknown = input
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input)
    } catch {
      return undefined
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined

  const keys = Object.keys(obj as Record<string, unknown>)
  if (keys.length === 0) return undefined

  // Every key must be a non-negative integer, and together they must form the
  // exact sequence 0..n-1 with no gaps.
  const indices: number[] = []
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return undefined
    indices.push(Number(k))
  }
  indices.sort((a, b) => a - b)
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i) return undefined
  }

  const record = obj as Record<string, unknown>
  let out = ""
  for (let i = 0; i < indices.length; i++) {
    const ch = record[String(i)]
    if (typeof ch !== "string" || ch.length !== 1) return undefined
    out += ch
  }
  return out
}

/**
 * Escape raw control characters (newlines, tabs, etc.) that appear *inside*
 * JSON string literals so the text becomes parseable. Characters outside string
 * literals — the structural whitespace of the JSON itself — are left untouched.
 * Returns the sanitized text, or `undefined` if the input is not a string.
 */
export function escapeRawControlCharsInStrings(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined

  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    const code = input.charCodeAt(i)
    if (inString && code < 0x20) {
      switch (ch) {
        case "\n":
          out += "\\n"
          break
        case "\r":
          out += "\\r"
          break
        case "\t":
          out += "\\t"
          break
        case "\b":
          out += "\\b"
          break
        case "\f":
          out += "\\f"
          break
        default:
          out += "\\u" + code.toString(16).padStart(4, "0")
      }
      continue
    }
    out += ch
  }
  return out
}

/**
 * Attempt to repair a malformed tool-call input into a well-formed JSON-object
 * string. Handles two shapes: the character-indexed payload, and JSON text with
 * raw control characters inside string literals (the "Unterminated string"
 * failure). Returns the repaired JSON string, or `undefined` when the input
 * cannot be safely recovered (callers should then surface a clean schema error
 * / retry).
 */
function tryCharIndexedRepair(input: unknown): string | undefined {
  const reconstructed = reconstructCharIndexedInput(input)
  if (reconstructed === undefined) return undefined
  try {
    const parsed = JSON.parse(reconstructed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return reconstructed
    }
  } catch {
    // reconstructed text was not valid JSON — fall through
  }
  return undefined
}

function tryStringControlCharRepair(input: string): string | undefined {
  if (input.length === 0) return undefined
  try {
    JSON.parse(input)
    return undefined
  } catch {
    const escaped = escapeRawControlCharsInStrings(input)
    if (escaped === undefined || escaped === input) return undefined
    try {
      const parsed = JSON.parse(escaped)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return escaped
      }
    } catch {
      // still not recoverable
    }
    return undefined
  }
}

/**
 * Repair the `question` tool input when a `questions` array item is missing the
 * required `question` field. Falls back to `header` if present. Returns the
 * repaired JSON string, or `undefined` if no repair was needed or possible.
 */
export function repairQuestionToolInput(input: unknown): string | undefined {
  let obj: Record<string, unknown> | undefined

  if (typeof input === "string") {
    try {
      obj = JSON.parse(input)
    } catch {
      return undefined
    }
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    obj = input as Record<string, unknown>
  } else {
    return undefined
  }

  if (!obj) return undefined
  const questions = obj["questions"]
  if (!Array.isArray(questions)) return undefined

  let modified = false
  for (const q of questions) {
    if (q && typeof q === "object" && !Array.isArray(q)) {
      const qObj = q as Record<string, unknown>
      if (typeof qObj.question !== "string" && typeof qObj.header === "string") {
        qObj.question = qObj.header
        modified = true
      }
    }
  }

  if (!modified) return undefined
  return typeof input === "string" ? JSON.stringify(obj) : JSON.stringify(obj)
}

export function repairToolCallInput(input: unknown): string | undefined {
  const fromCharIndex = tryCharIndexedRepair(input)
  if (fromCharIndex !== undefined) return fromCharIndex

  if (typeof input !== "string") return undefined
  return tryStringControlCharRepair(input)
}
