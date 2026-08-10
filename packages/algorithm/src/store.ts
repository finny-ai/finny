import { z } from "zod"
import { TenantId, TenantIdSchema } from "./identity"
import { ContentDigest, ContentDigestSchema } from "./records"

export const StoreRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).brand<"StoreRevision">()
export type StoreRevision = z.infer<typeof StoreRevisionSchema>

export const TenantScopeSchema = z.object({ tenantId: TenantIdSchema }).strict()
export type TenantScope = z.infer<typeof TenantScopeSchema>

export type StoredRecord<Value> = Readonly<{
  value: Value
  revision: StoreRevision
}>

export type RecordReadResult<Value> =
  | Readonly<{ status: "found"; record: StoredRecord<Value> }>
  | Readonly<{ status: "not_found" }>

export type RecordWriteResult<Value> =
  | Readonly<{ status: "written"; record: StoredRecord<Value> }>
  | Readonly<{
      status: "revision_conflict"
      expectedRevision: StoreRevision | null
      actualRevision: StoreRevision | null
    }>

/**
 * Tenant scope is mandatory on every call. Writes use compare-and-swap:
 * `null` expects absence; a revision expects that exact current revision. A
 * successful write must advance monotonically to the revision returned by
 * `evaluateRecordCas`; adapters must never reuse or decrease revisions.
 *
 * Hard delete is deliberately absent. Retirement is a lifecycle transition and
 * migrations move records aside. If deletion is introduced later, adapters may
 * use durable tombstones behind a separately reviewed contract.
 */
export interface RecordStore<Key, Value> {
  read(input: Readonly<{ tenantId: TenantId; key: Key }>): Promise<RecordReadResult<Value>>
  write(
    input: Readonly<{
      tenantId: TenantId
      key: Key
      value: Value
      expectedRevision: StoreRevision | null
    }>,
  ): Promise<RecordWriteResult<Value>>
}

export type ArtifactReadResult<Artifact> =
  | Readonly<{ status: "found"; artifact: Artifact; digest: ContentDigest }>
  | Readonly<{ status: "not_found" }>

export type ArtifactWriteResult =
  | Readonly<{ status: "created"; digest: ContentDigest }>
  | Readonly<{ status: "idempotent"; digest: ContentDigest }>
  | Readonly<{
      status: "digest_conflict"
      existingDigest: ContentDigest
      attemptedDigest: ContentDigest
    }>

/** Immutable artifacts: the same key and digest is idempotent; a different digest must be rejected. */
export interface ArtifactStore<Key, Artifact> {
  read(input: Readonly<{ tenantId: TenantId; key: Key }>): Promise<ArtifactReadResult<Artifact>>
  writeImmutable(
    input: Readonly<{
      tenantId: TenantId
      key: Key
      artifact: Artifact
      digest: ContentDigest
    }>,
  ): Promise<ArtifactWriteResult>
}

export type RecordCasDecision =
  | Readonly<{ status: "matched"; nextRevision: StoreRevision }>
  | Readonly<{
      status: "revision_conflict"
      expectedRevision: StoreRevision | null
      actualRevision: StoreRevision | null
    }>

/** Shared CAS semantics for adapters; `null` means the caller expects no existing record. */
export function evaluateRecordCas(
  expectedRevision: StoreRevision | null,
  actualRevision: StoreRevision | null,
): RecordCasDecision {
  if (expectedRevision !== actualRevision) {
    return { status: "revision_conflict", expectedRevision, actualRevision }
  }
  const next = (actualRevision ?? 0) + 1
  return { status: "matched", nextRevision: StoreRevisionSchema.parse(next) }
}

export type ImmutableArtifactWriteDecision =
  | Readonly<{ status: "created"; digest: ContentDigest }>
  | Readonly<{ status: "idempotent"; digest: ContentDigest }>
  | Readonly<{
      status: "digest_conflict"
      existingDigest: ContentDigest
      attemptedDigest: ContentDigest
    }>

/** Shared immutable-write semantics for storage adapters. */
export function evaluateImmutableArtifactWrite(
  existingDigest: ContentDigest | null,
  attemptedDigest: ContentDigest,
): ImmutableArtifactWriteDecision {
  const attempted = ContentDigestSchema.parse(attemptedDigest)
  if (existingDigest === null) return { status: "created", digest: attempted }
  const existing = ContentDigestSchema.parse(existingDigest)
  if (existing === attempted) return { status: "idempotent", digest: existing }
  return { status: "digest_conflict", existingDigest: existing, attemptedDigest: attempted }
}
