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
 * Attempt to repair a malformed tool-call input into a well-formed JSON-object
 * string. Currently handles the character-indexed payload shape. Returns the
 * repaired JSON string, or `undefined` when the input cannot be safely
 * recovered (callers should then surface a clean schema error / retry).
 */
export function repairToolCallInput(input: unknown): string | undefined {
  const reconstructed = reconstructCharIndexedInput(input)
  if (reconstructed === undefined) return undefined
  try {
    const parsed = JSON.parse(reconstructed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return reconstructed
    }
  } catch {
    // reconstructed text was not valid JSON — not safely recoverable
  }
  return undefined
}
