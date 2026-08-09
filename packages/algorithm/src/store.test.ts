import { describe, expect, test } from "bun:test"
import { TenantIdSchema } from "./identity"
import { ContentDigestSchema } from "./records"
import {
  ArtifactStore,
  RecordStore,
  StoreRevisionSchema,
  evaluateImmutableArtifactWrite,
  evaluateRecordCas,
} from "./store"

const tenantId = TenantIdSchema.parse("org_123")
const digestA = ContentDigestSchema.parse(`sha256:${"a".repeat(64)}`)
const digestB = ContentDigestSchema.parse(`sha256:${"b".repeat(64)}`)

describe("storage port contracts", () => {
  test("CAS creates at revision 1 and advances only an exact revision", () => {
    const revision1 = StoreRevisionSchema.parse(1)
    const revision2 = StoreRevisionSchema.parse(2)
    const revision3 = StoreRevisionSchema.parse(3)
    expect(evaluateRecordCas(null, null)).toEqual({ status: "matched", nextRevision: revision1 })
    expect(evaluateRecordCas(revision2, revision2)).toEqual({
      status: "matched",
      nextRevision: revision3,
    })
    expect(evaluateRecordCas(null, revision1)).toEqual({
      status: "revision_conflict",
      expectedRevision: null,
      actualRevision: revision1,
    })
    expect(evaluateRecordCas(revision1, null)).toEqual({
      status: "revision_conflict",
      expectedRevision: revision1,
      actualRevision: null,
    })

    let revision = revision1
    for (let expected = 2; expected <= 4; expected++) {
      const decision = evaluateRecordCas(revision, revision)
      expect(decision.status).toBe("matched")
      if (decision.status !== "matched") throw new Error("exact CAS unexpectedly failed")
      expect(Number(decision.nextRevision)).toBe(expected)
      revision = decision.nextRevision
    }
  })

  test("immutable writes are same-digest idempotent and reject conflicting content", () => {
    expect(evaluateImmutableArtifactWrite(null, digestA)).toEqual({ status: "created", digest: digestA })
    expect(evaluateImmutableArtifactWrite(digestA, digestA)).toEqual({ status: "idempotent", digest: digestA })
    expect(evaluateImmutableArtifactWrite(digestA, digestB)).toEqual({
      status: "digest_conflict",
      existingDigest: digestA,
      attemptedDigest: digestB,
    })
  })

  test("ports require tenant scope and expose explicit result shapes", async () => {
    const records: RecordStore<string, { name: string }> = {
      async read(input) {
        expect(input.tenantId).toBe(tenantId)
        return { status: "not_found" }
      },
      async write(input) {
        expect(input.expectedRevision).toBeNull()
        return { status: "written", record: { value: input.value, revision: StoreRevisionSchema.parse(1) } }
      },
    }
    const artifacts: ArtifactStore<string, Uint8Array> = {
      async read(input) {
        expect(input.tenantId).toBe(tenantId)
        return { status: "not_found" }
      },
      async writeImmutable(input) {
        return evaluateImmutableArtifactWrite(null, input.digest)
      },
    }

    expect(await records.read({ tenantId, key: "algo" })).toEqual({ status: "not_found" })
    expect("delete" in records).toBe(false)
    expect(
      await records.write({ tenantId, key: "algo", value: { name: "example" }, expectedRevision: null }),
    ).toMatchObject({ status: "written", record: { revision: 1 } })
    expect(
      await artifacts.writeImmutable({ tenantId, key: "manifest", artifact: new Uint8Array(), digest: digestA }),
    ).toEqual({ status: "created", digest: digestA })
  })
})
