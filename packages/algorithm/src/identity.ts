import { z } from "zod"

const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/

function hasValidUnicode(value: string): boolean {
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

/** Stable tenant identity supplied by the control plane. */
export const TenantIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), "tenantId must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "tenantId must not contain control characters")
  .refine(hasValidUnicode, "tenantId must contain valid Unicode")
  .brand<"TenantId">()
export type TenantId = z.infer<typeof TenantIdSchema>

/**
 * Stable, opaque algorithm identity. Creation belongs to an application adapter,
 * not this domain package. Existing UUIDs and legacy non-empty identifiers remain valid.
 */
export const AlgorithmIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), "algorithmId must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "algorithmId must not contain control characters")
  .refine(hasValidUnicode, "algorithmId must contain valid Unicode")
  .brand<"AlgorithmId">()
export type AlgorithmId = z.infer<typeof AlgorithmIdSchema>

/** Human-readable alias. Its uniqueness is scoped by TenantId, never global. */
export const AlgorithmSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(CANONICAL_SLUG, "slug must be a lowercase, path-safe segment")
  .brand<"AlgorithmSlug">()
export type AlgorithmSlug = z.infer<typeof AlgorithmSlugSchema>

export const AlgorithmVersionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .brand<"AlgorithmVersion">()
export type AlgorithmVersion = z.infer<typeof AlgorithmVersionSchema>

export const AlgorithmVersionRefSchema = z
  .object({
    algorithmId: AlgorithmIdSchema,
    version: AlgorithmVersionSchema,
  })
  .strict()
  .readonly()
export type AlgorithmVersionRef = z.infer<typeof AlgorithmVersionRefSchema>

export class InvalidExactAlgorithmVersionRefError extends Error {
  readonly value: string

  constructor(value: string, detail: string) {
    super(`invalid exact algorithm version ref ${JSON.stringify(value)}: ${detail}`)
    this.name = "InvalidExactAlgorithmVersionRefError"
    this.value = value
  }
}

/** Format an exact, immutable reference. Moving aliases are deliberately unsupported. */
export function formatAlgorithmVersionRef(input: AlgorithmVersionRef): string {
  const ref = AlgorithmVersionRefSchema.parse(input)
  return `algo:${encodeURIComponent(ref.algorithmId)}@v${ref.version}`
}

/**
 * Parse only canonical exact refs (`algo:<opaque-id>@v<positive-integer>`).
 * `@latest`, `@qualified`, `@paper`, `@live`, digest refs, and unversioned refs fail closed.
 */
export function parseAlgorithmVersionRef(value: string): AlgorithmVersionRef {
  const match = /^algo:(.+)@v([1-9]\d*)$/.exec(value)
  if (!match) {
    throw new InvalidExactAlgorithmVersionRefError(
      value,
      "expected algo:<percent-encoded-algorithm-id>@v<positive-version>; moving refs are not exact",
    )
  }

  let algorithmId: string
  try {
    algorithmId = decodeURIComponent(match[1])
  } catch {
    throw new InvalidExactAlgorithmVersionRefError(value, "algorithmId contains invalid percent encoding")
  }

  const version = Number(match[2])
  const parsed = AlgorithmVersionRefSchema.safeParse({ algorithmId, version })
  if (!parsed.success) {
    throw new InvalidExactAlgorithmVersionRefError(value, parsed.error.issues[0]?.message ?? "invalid identity")
  }

  if (formatAlgorithmVersionRef(parsed.data) !== value) {
    throw new InvalidExactAlgorithmVersionRefError(value, "reference is not in canonical form")
  }
  return parsed.data
}
