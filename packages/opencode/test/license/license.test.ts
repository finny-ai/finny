import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DeviceProfile } from "@/device"
import { License } from "@/license"

let tempDir: string
let originalUrl: string | undefined
let originalKey: string | undefined
let originalBypass: string | undefined
let originalClient: string | undefined
let originalStateDir: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-license-test-"))
  originalUrl = process.env.FINNY_LICENSE_CHECK_URL
  originalKey = process.env.FINNY_LICENSE_KEY
  originalBypass = process.env.FINNY_LICENSE_BYPASS
  originalClient = process.env.FINNY_LICENSE_CLIENT
  originalStateDir = process.env.FINNY_LICENSE_STATE_DIR
  process.env.FINNY_LICENSE_CHECK_URL = "https://license.test/check"
  delete process.env.FINNY_LICENSE_KEY
  delete process.env.FINNY_LICENSE_BYPASS
  delete process.env.FINNY_LICENSE_CLIENT
  delete process.env.FINNY_LICENSE_STATE_DIR
  DeviceProfile._resetForTests()
  License._resetForTests()
  License._setCacheDirForTests(tempDir)
})

afterEach(async () => {
  if (originalUrl === undefined) delete process.env.FINNY_LICENSE_CHECK_URL
  else process.env.FINNY_LICENSE_CHECK_URL = originalUrl
  if (originalKey === undefined) delete process.env.FINNY_LICENSE_KEY
  else process.env.FINNY_LICENSE_KEY = originalKey
  if (originalBypass === undefined) delete process.env.FINNY_LICENSE_BYPASS
  else process.env.FINNY_LICENSE_BYPASS = originalBypass
  if (originalClient === undefined) delete process.env.FINNY_LICENSE_CLIENT
  else process.env.FINNY_LICENSE_CLIENT = originalClient
  if (originalStateDir === undefined) delete process.env.FINNY_LICENSE_STATE_DIR
  else process.env.FINNY_LICENSE_STATE_DIR = originalStateDir
  DeviceProfile._resetForTests()
  License._resetForTests()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("License", () => {
  test("valid activation sends only license check fields and stores local hashes", async () => {
    let payload: Record<string, unknown> | undefined

    License._setFetchForTests((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      payload = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          ok: true,
          orgId: "org_dv_trading",
          orgName: "DV Trading",
          deviceLimitReached: false,
          nextCheckAfter: "2026-06-02T12:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as unknown as typeof fetch)

    await License.activate(" finny_valid_key ")

    expect(payload).toBeDefined()
    expect(Object.keys(payload!).sort()).toEqual([
      "appVersion",
      "client",
      "licenseKeyHash",
      "machineIdHash",
      "timestamp",
    ])
    expect(payload!.client).toBe("finny-pro")
    expect(payload!.licenseKeyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(payload!.machineIdHash).toMatch(/^[a-f0-9]{64}$/)

    for (const forbidden of [
      "org_id",
      "orgId",
      "prompt",
      "symbol",
      "strategy_code",
      "market_data",
      "backtest_metrics",
      "pnl",
      "requested_feature",
      "plan",
      "seat_count",
    ]) {
      expect(Object.hasOwn(payload!, forbidden)).toBe(false)
    }

    const cache = JSON.parse(await fs.readFile(path.join(tempDir, "license-cache.json"), "utf8"))
    expect(cache.schema_version).toBe(2)
    expect(cache.org_id).toBe("org_dv_trading")
    expect(cache.org_name).toBe("DV Trading")
    expect(cache.license_key_hash).toEqual(payload!.licenseKeyHash)
    expect(cache.machine_id_hash).toEqual(payload!.machineIdHash)
    expect(cache.last_ok_at).toEqual(expect.any(String))
    expect(cache.next_check_after).toBe("2026-06-02T12:00:00.000Z")
    expect(cache.plan_type).toBeUndefined()
    expect(cache.devices_used).toBeUndefined()
    expect(cache.device_limit).toBeUndefined()
  })

  test("uses api.finnyai.tech license proxy by default", async () => {
    delete process.env.FINNY_LICENSE_CHECK_URL
    let url: string | URL | Request | undefined

    License._setFetchForTests((async (input: Parameters<typeof fetch>[0]) => {
      url = input
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")

    expect(String(url)).toBe("https://api.finnyai.tech/v1/license/check")
  })

  test("allows license client id override for alternate package entrypoints", async () => {
    process.env.FINNY_LICENSE_CLIENT = "finny-internal-prop"
    let payload: Record<string, unknown> | undefined

    License._setFetchForTests((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      payload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")

    expect(payload?.client).toBe("finny-internal-prop")
  })

  test("FINNY_LICENSE_STATE_DIR stores device, license, and terms state together", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-license-state-test-"))
    License._resetForTests()
    DeviceProfile._resetForTests()
    process.env.FINNY_LICENSE_STATE_DIR = stateDir
    let payload: Record<string, unknown> | undefined

    License._setFetchForTests((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      payload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")
    await License.recordTermsAcceptance()

    const device = JSON.parse(await fs.readFile(path.join(stateDir, "device.json"), "utf8"))
    const cache = JSON.parse(await fs.readFile(path.join(stateDir, "license-cache.json"), "utf8"))
    const terms = JSON.parse(await fs.readFile(path.join(stateDir, "terms-acceptance.json"), "utf8"))

    expect(device.userId).toEqual(expect.any(String))
    expect(cache.machine_id_hash).toBe(payload?.machineIdHash)
    expect(cache.license_key_hash).toBe(License.hashLicenseKey("finny_valid_key"))
    expect(terms.version).toBe(License.termsVersion)
    await expect(fs.access(path.join(tempDir, "license-cache.json"))).rejects.toThrow()
    await fs.rm(stateDir, { recursive: true, force: true })
  })

  test("empty or malformed 200 does not unlock license", async () => {
    License._setFetchForTests((async () => new Response(null, { status: 200 })) as unknown as typeof fetch)

    await expect(License.activate("finny_empty_200")).rejects.toThrow(
      "Could not verify license. Please check your connection or contact Finny.",
    )
    await expect(fs.access(path.join(tempDir, "license-cache.json"))).rejects.toThrow()
  })

  test("invalid activation returns access denied and does not write cache", async () => {
    License._setFetchForTests((async () => new Response(null, { status: 403 })) as unknown as typeof fetch)

    await expect(License.activate("finny_invalid")).rejects.toThrow("Access denied. Please contact Finny.")
    await expect(fs.access(path.join(tempDir, "license-cache.json"))).rejects.toThrow()
  })

  test("server JSON denial message is surfaced to the activation error", async () => {
    License._setFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            deviceLimitReached: true,
            message: "This license is already active on the maximum number of devices.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    )

    await expect(License.activate("finny_device_limit")).rejects.toThrow(
      "This license is already active on the maximum number of devices.",
    )
  })

  test("second launch within 24 hours does not call platform", async () => {
    let calls = 0
    License._setFetchForTests((async () => {
      calls++
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")

    License._setFetchForTests((async () => {
      throw new Error("unexpected remote check")
    }) as unknown as typeof fetch)

    await License.ensureActive()
    expect(calls).toBe(1)
  })

  test("stale cache calls platform again and blocks on 403", async () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z")
    License._setNowForTests(() => t0)
    License._setFetchForTests(
      (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    )
    await License.activate("finny_valid_key")

    let rechecked = false
    License._setNowForTests(() => t0 + 25 * 60 * 60 * 1000)
    License._setFetchForTests((async () => {
      rechecked = true
      return new Response(null, { status: 403 })
    }) as unknown as typeof fetch)

    await expect(License.ensureActive()).rejects.toThrow("Access denied. Please contact Finny.")
    expect(rechecked).toBe(true)
  })

  test("explicit FINNY_LICENSE_KEY activates even when a stale cache exists", async () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z")
    const payloads: Record<string, unknown>[] = []
    License._setNowForTests(() => t0)
    License._setFetchForTests((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      payloads.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)
    await License.activate("old_key")

    process.env.FINNY_LICENSE_KEY = "new_key"
    License._setNowForTests(() => t0 + 25 * 60 * 60 * 1000)
    await License.ensureActive()

    expect(payloads).toHaveLength(2)
    expect(payloads[1]!.licenseKeyHash).toBe(License.hashLicenseKey("new_key"))
    expect(payloads[1]!.licenseKeyHash).not.toBe(payloads[0]!.licenseKeyHash)
  })

  test("fresh cache avoids remote activation when FINNY_LICENSE_KEY matches", async () => {
    let calls = 0
    License._setFetchForTests((async () => {
      calls++
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")
    process.env.FINNY_LICENSE_KEY = "finny_valid_key"

    License._setFetchForTests((async () => {
      throw new Error("unexpected remote check")
    }) as unknown as typeof fetch)

    await License.ensureActive()
    expect(calls).toBe(1)
  })

  test("legacy org-scoped cache unlocks until it is rewritten by the next remote check", async () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z")
    License._setNowForTests(() => t0)
    const machineHash = await License.machineIdHash()
    await fs.writeFile(
      path.join(tempDir, "license-cache.json"),
      JSON.stringify({
        org_id: "old_org",
        license_key_hash: License.hashLicenseKey("finny_valid_key"),
        machine_id_hash: machineHash,
        last_ok_at: new Date(t0).toISOString(),
        plan_type: "per_head",
        devices_used: 1,
        device_limit: 2,
      }),
    )

    License._setFetchForTests((async () => {
      throw new Error("unexpected remote check")
    }) as unknown as typeof fetch)

    await License.ensureActive()
    const status = await License.currentStatus()
    expect(status.active).toBe(true)
    expect(status.org_id).toBe("old_org")
  })
})
