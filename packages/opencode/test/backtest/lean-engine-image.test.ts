import { describe, expect, test } from "bun:test"
import { nextPinnedConstants, pinnedImagePullRefs } from "../../src/backtest/lean/engine-image"

const SAMPLE_CONTRACTS = `export const LEAN_PINNED_COMMIT = "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0"
export const LEAN_PINNED_IMAGE_DIGEST = "sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652"`

const SAMPLE_DOCKERFILE = `FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG LEAN_COMMIT=c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0`

describe("nextPinnedConstants", () => {
  test("updates the commit in both files and the digest in contracts", () => {
    const patched = nextPinnedConstants(
      SAMPLE_CONTRACTS,
      SAMPLE_DOCKERFILE,
      "d2c3659f877bfc2b5d9dc0fc89a9c7566f45e892",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(patched).not.toBeNull()
    expect(patched!.contracts).toContain('LEAN_PINNED_COMMIT = "d2c3659f877bfc2b5d9dc0fc89a9c7566f45e892"')
    expect(patched!.contracts).toContain(
      'LEAN_PINNED_IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    )
    expect(patched!.dockerfile).toContain("ARG LEAN_COMMIT=d2c3659f877bfc2b5d9dc0fc89a9c7566f45e892")
  })

  test("returns null when the constant shapes are missing", () => {
    expect(nextPinnedConstants("no constants here", SAMPLE_DOCKERFILE, "abc", "digest")).toBeNull()
    expect(nextPinnedConstants(SAMPLE_CONTRACTS, "no ARG here", "abc", "digest")).toBeNull()
  })

  test("returns null when already on the target commit and digest (nothing to patch)", () => {
    const patched = nextPinnedConstants(
      SAMPLE_CONTRACTS,
      SAMPLE_DOCKERFILE,
      "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
      "sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652",
    )
    expect(patched).toBeNull()
  })
})

describe("pinnedImagePullRefs", () => {
  const refs = pinnedImagePullRefs(
    "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
    "sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652",
  )

  test("tries the pinned digest first so no tag is required", () => {
    expect(refs[0]!.ref).toBe(
      "ghcr.io/finny-ai/lean-engine@sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652",
    )
    expect(refs[0]!.label).toContain("pinned digest")
  })

  test("includes latest, commit, and dev tags as verified fallbacks", () => {
    expect(refs.map((entry) => entry.ref)).toEqual([
      "ghcr.io/finny-ai/lean-engine@sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652",
      "ghcr.io/finny-ai/lean-engine:latest",
      "ghcr.io/finny-ai/lean-engine:c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
      "ghcr.io/finny-ai/lean-engine:dev",
    ])
  })
})
