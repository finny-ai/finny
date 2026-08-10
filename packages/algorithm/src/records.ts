import { z } from "zod"
import {
  AlgorithmIdSchema,
  AlgorithmSlugSchema,
  AlgorithmVersionRefSchema,
  AlgorithmVersionSchema,
  TenantIdSchema,
} from "./identity"
import { UtcTimestampSchema } from "./time"

export const ContentDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "content digest must be canonical sha256:<lowercase-hex>")
  .brand<"ContentDigest">()
export type ContentDigest = z.infer<typeof ContentDigestSchema>

/** Mutable identity/alias projection. Version content and lifecycle are stored separately. */
export const AlgorithmRecordSchema = z
  .object({
    tenantId: TenantIdSchema,
    algorithmId: AlgorithmIdSchema,
    slug: AlgorithmSlugSchema,
    latestVersion: AlgorithmVersionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict()
export type AlgorithmRecord = z.infer<typeof AlgorithmRecordSchema>

export const AlgorithmVersionLineageSchema = z
  .object({
    parent: AlgorithmVersionRefSchema.nullable(),
  })
  .strict()
  .readonly()
export type AlgorithmVersionLineage = z.infer<typeof AlgorithmVersionLineageSchema>

/** Immutable metadata for one content-addressed version. */
export const AlgorithmVersionRecordSchema = z
  .object({
    tenantId: TenantIdSchema,
    ref: AlgorithmVersionRefSchema,
    contentDigest: ContentDigestSchema,
    lineage: AlgorithmVersionLineageSchema,
    createdAt: UtcTimestampSchema,
  })
  .strict()
  .readonly()
export type AlgorithmVersionRecord = z.infer<typeof AlgorithmVersionRecordSchema>
