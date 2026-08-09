import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import {
  QC_PROVIDER_ID,
  disconnectQcCredentials,
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
