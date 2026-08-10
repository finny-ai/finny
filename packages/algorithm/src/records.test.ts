import { describe, expect, test } from "bun:test"
import { AlgorithmVersionLifecycleRecordSchema } from "./lifecycle"
import { AlgorithmRecordSchema, AlgorithmVersionRecordSchema, ContentDigestSchema } from "./records"

const digest = ContentDigestSchema.parse(`sha256:${"a".repeat(64)}`)

describe("algorithm records", () => {
  test("parses tenant-scoped identity separately from immutable version content", () => {
    const algorithm = AlgorithmRecordSchema.parse({
      tenantId: "org_123",
      algorithmId: "b9abdd1a-3f0c-428c-ad5d-eb2a4bd7ca95",
      slug: "spy-mean-reversion",
      latestVersion: 2,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T13:00:00.000Z",
    })
    expect(String(algorithm.slug)).toBe("spy-mean-reversion")

    const version = AlgorithmVersionRecordSchema.parse({
      tenantId: algorithm.tenantId,
      ref: { algorithmId: algorithm.algorithmId, version: 2 },
      contentDigest: digest,
      lineage: { parent: { algorithmId: "source-algorithm", version: 7 } },
      createdAt: "2026-08-08T13:00:00.000Z",
    })
    expect(String(version.lineage.parent?.algorithmId)).toBe("source-algorithm")
    expect(Number(version.lineage.parent?.version)).toBe(7)
    expect(Object.isFrozen(version)).toBe(true)
  })

  test("supports an explicit root lineage and rejects moving lineage refs", () => {
    const root = AlgorithmVersionRecordSchema.parse({
      tenantId: "org_123",
      ref: { algorithmId: "root", version: 1 },
      contentDigest: digest,
      lineage: { parent: null },
      createdAt: "2026-08-08T13:00:00.000Z",
    })
    expect(root.lineage.parent).toBeNull()

    expect(
      AlgorithmVersionRecordSchema.safeParse({
        ...root,
        lineage: { parent: "algo:root@latest" },
      }).success,
    ).toBe(false)
  })

  test("keeps mutable lifecycle state out of immutable version records", () => {
    const lifecycle = AlgorithmVersionLifecycleRecordSchema.parse({
      tenantId: "org_123",
      ref: { algorithmId: "root", version: 1 },
      state: "validated",
      updatedAt: "2026-08-08T13:00:00.000Z",
    })
    expect(lifecycle.state).toBe("validated")
    expect(
      AlgorithmVersionRecordSchema.safeParse({
        tenantId: "org_123",
        ref: lifecycle.ref,
        contentDigest: digest,
        lineage: { parent: null },
        createdAt: "2026-08-08T13:00:00.000Z",
        state: lifecycle.state,
      }).success,
    ).toBe(false)
  })
})
