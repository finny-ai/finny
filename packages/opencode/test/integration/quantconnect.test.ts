import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import {
  QC_PROVIDER_ID,
  disconnectQcCredentials,
  qcAuthHeaders,
  qcApiRequest,
  qcCredentialPresentSync,
  readQcCredentials,
} from "../../src/integration/quantconnect"

const originalFinnyHome = process.env.FINNY_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
})

describe("QuantConnect credential connection", () => {
  test("derives the official timestamped-hash authentication headers", () => {
    const headers = qcAuthHeaders({ userId: "42", apiToken: "deadbeef" }, 1700000000)
    expect(headers.Timestamp).toBe("1700000000")
    expect(headers.Authorization).toBe(
      "Basic NDI6MGI4OWUxMzEwNDkyODMyZGZlNDY1ZjkxYzU3OTRiMzFiZDc5NGFhNThjMjI0MTU1ZWIzMGExNjFjOWFjOWJhOA==",
    )
    // The raw token must never appear in the signed header.
    expect(headers.Authorization).not.toContain("deadbeef")
  })

  test("matches the reference implementation for a realistic credential set", () => {
    const headers = qcAuthHeaders({ userId: "1001200", apiToken: "cf17c7b00ceb48f3ac6fca5f8a48a6e2" }, 1754160000)
    expect(headers.Authorization).toBe(
      "Basic MTAwMTIwMDo0MTQyMmIyMzhkMmY3YzE4YmQzZTVmYjk1NjEzNDQyNTBiYTkwOWYwMzNlMzE3M2E5NGIxNDM5ZDk3NTAyZDA1",
    )
  })

  test("changes the signature for every request timestamp", () => {
    const first = qcAuthHeaders({ userId: "42", apiToken: "deadbeef" }, 1700000000)
    const second = qcAuthHeaders({ userId: "42", apiToken: "deadbeef" }, 1700000001)
    expect(first.Authorization).not.toBe(second.Authorization)
    expect(first.Timestamp).toBe("1700000000")
    expect(second.Timestamp).toBe("1700000001")
  })

  test("throws on QC API failure bodies", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, errors: ["invalid credentials"] }), { status: 200 }),
      )) as unknown as typeof fetch
    try {
      await expect(
        qcApiRequest({ path: "/authenticate", credentials: { userId: "42", apiToken: "deadbeef" } }),
      ).rejects.toThrow("invalid credentials")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reads stored QC API credentials and reports presence", async () => {
    const home = `/tmp/finny-qc-test-${Math.random().toString(36).slice(2)}`
    process.env.FINNY_HOME = home
    cleanups.push(home)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "qc-token-123", metadata: { userId: "qc-user-42" } },
    })
    const credentials = await readQcCredentials()
    expect(credentials).toEqual({ userId: "qc-user-42", apiToken: "qc-token-123" })
    expect(qcCredentialPresentSync()).toBe(true)
  })

  test("reports no QC connection when credentials are absent", async () => {
    expect(await readQcCredentials()).toBeNull()
    expect(qcCredentialPresentSync()).toBe(false)
  })

  test("removes stored QC credentials", async () => {
    const home = `/tmp/finny-qc-test-${Math.random().toString(36).slice(2)}`
    process.env.FINNY_HOME = home
    cleanups.push(home)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [QC_PROVIDER_ID]: { type: "api", key: "qc-token-123", metadata: { userId: "qc-user-42" } },
    })
    await disconnectQcCredentials()
    // Auth.remove persists to disk; drop the env override so reads reflect the store.
    delete process.env.OPENCODE_AUTH_CONTENT
    expect(await readQcCredentials()).toBeNull()
  })
})
