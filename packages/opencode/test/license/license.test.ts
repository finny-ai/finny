import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { License } from "@/license"

let tempDir: string
let originalUrl: string | undefined
let originalKey: string | undefined
let originalBypass: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-license-test-"))
  originalUrl = process.env.FINNY_LICENSE_CHECK_URL
  originalKey = process.env.FINNY_LICENSE_KEY
  originalBypass = process.env.FINNY_LICENSE_BYPASS
  process.env.FINNY_LICENSE_CHECK_URL = "https://license.test/check"
  delete process.env.FINNY_LICENSE_KEY
  delete process.env.FINNY_LICENSE_BYPASS
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
  License._resetForTests()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("License", () => {
  test("valid activation sends only license check fields and stores local hashes", async () => {
    let payload: Record<string, unknown> | undefined

    License._setFetchForTests((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      payload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true, plan_type: "per_head" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate(" finny_valid_key ")

    expect(payload).toBeDefined()
    expect(Object.keys(payload!).sort()).toEqual([
      "app_version",
      "license_key_hash",
      "machine_id_hash",
      "org_id",
      "timestamp",
    ])
    expect(payload!.org_id).toBe("consumer")
    expect(payload!.license_key_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(payload!.machine_id_hash).toMatch(/^[a-f0-9]{64}$/)

    for (const forbidden of [
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
    expect(cache.org_id).toBe("consumer")
    expect(cache.license_key_hash).toEqual(payload!.license_key_hash)
    expect(cache.machine_id_hash).toEqual(payload!.machine_id_hash)
    expect(cache.last_ok_at).toEqual(expect.any(String))
  })

  test("uses api.finnyai.tech license proxy by default", async () => {
    delete process.env.FINNY_LICENSE_CHECK_URL
    let url: string | URL | Request | undefined

    License._setFetchForTests((async (input: Parameters<typeof fetch>[0]) => {
      url = input
      return new Response(JSON.stringify({ ok: true, plan_type: "enterprise" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)

    await License.activate("finny_valid_key")

    expect(String(url)).toBe("https://api.finnyai.tech/v1/license/check")
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
    License._setFetchForTests((async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: "device_limit_reached",
          message: "Access denied. Already configured on 2 devices.",
          devices_used: 2,
          device_limit: 2,
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch)

    await expect(License.activate("finny_device_limit")).rejects.toThrow(
      "Access denied. Already configured on 2 devices.",
    )
  })

  test("second launch within 24 hours does not call Convex", async () => {
    let calls = 0
    License._setFetchForTests((async () => {
      calls++
      return new Response(JSON.stringify({ ok: true, plan_type: "per_head" }), {
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

  test("stale cache calls Convex again and blocks on 403", async () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z")
    License._setNowForTests(() => t0)
    License._setFetchForTests((async () =>
      new Response(JSON.stringify({ ok: true, plan_type: "per_head" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch)
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
      return new Response(JSON.stringify({ ok: true, plan_type: "per_head" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)
    await License.activate("old_key")

    process.env.FINNY_LICENSE_KEY = "new_key"
    License._setNowForTests(() => t0 + 25 * 60 * 60 * 1000)
    await License.ensureActive()

    expect(payloads).toHaveLength(2)
    expect(payloads[1]!.license_key_hash).toBe(License.hashLicenseKey("new_key"))
    expect(payloads[1]!.license_key_hash).not.toBe(payloads[0]!.license_key_hash)
  })

  test("fresh cache avoids remote activation when FINNY_LICENSE_KEY matches", async () => {
    let calls = 0
    License._setFetchForTests((async () => {
      calls++
      return new Response(JSON.stringify({ ok: true, plan_type: "per_head" }), {
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
})
