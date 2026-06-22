import crypto from "crypto"
import path from "path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { DeviceProfile } from "@/device"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"

const CACHE_FILE = "license-cache.json"
const GRACE_MS = 24 * 60 * 60 * 1000
const DEFAULT_CHECK_URL = "https://api.finnyai.tech/v1/license/check"
const DEFAULT_ORG_ID = "consumer"

type Cache = {
  org_id: string
  license_key_hash: string
  machine_id_hash: string
  last_ok_at: string
  plan_type?: "enterprise" | "per_head"
  next_check_after?: string
  devices_used?: number
  device_limit?: number
}

type CheckOk = {
  ok: true
  plan_type?: "enterprise" | "per_head"
  next_check_after?: string
  devices_used?: number
  device_limit?: number
}

type CheckDenied = {
  ok: false
  error_code?: string
  message?: string
  devices_used?: number
  device_limit?: number
}

type CheckResult = CheckOk | CheckDenied

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
let nowImpl = () => Date.now()
let cacheDirOverride: string | undefined

function cachePath() {
  return path.join(cacheDirOverride ?? Global.Path.data, CACHE_FILE)
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function isBypassEnabled() {
  const value = process.env.FINNY_LICENSE_BYPASS
  return value === "1" || value?.toLowerCase() === "true"
}

function checkUrl() {
  return process.env.FINNY_LICENSE_CHECK_URL?.trim() || DEFAULT_CHECK_URL
}

function orgId() {
  return process.env.FINNY_LICENSE_ORG_ID?.trim() || DEFAULT_ORG_ID
}

function isFresh(cache: Cache, now = nowImpl()) {
  const lastOk = Date.parse(cache.last_ok_at)
  return Number.isFinite(lastOk) && now - lastOk < GRACE_MS
}

async function readCache(): Promise<Cache | null> {
  try {
    const cache = await Filesystem.readJson<Cache>(cachePath())
    if (!cache.org_id || !cache.license_key_hash || !cache.machine_id_hash || !cache.last_ok_at) return null
    return cache
  } catch {
    return null
  }
}

async function writeCache(input: {
  orgID: string
  licenseKeyHash: string
  machineIdHash: string
  result?: CheckOk
}) {
  await Filesystem.writeJson(
    cachePath(),
    {
      org_id: input.orgID,
      license_key_hash: input.licenseKeyHash,
      machine_id_hash: input.machineIdHash,
      last_ok_at: new Date(nowImpl()).toISOString(),
      plan_type: input.result?.plan_type,
      next_check_after: input.result?.next_check_after,
      devices_used: input.result?.devices_used,
      device_limit: input.result?.device_limit,
    } satisfies Cache,
    0o600,
  )
}

export namespace License {
  export class AccessDeniedError extends Error {
    constructor(message = "Access denied. Please contact Finny.") {
      super(message)
      this.name = "AccessDeniedError"
    }
  }

  export class VerificationError extends Error {
    constructor(message = "Could not verify license. Please check your connection or contact Finny.") {
      super(message)
      this.name = "VerificationError"
    }
  }

  export const RESTRICTED_TOOL_IDS = new Set([
    "finny_algorithm_scaffold",
    "finny_algorithm_save",
    "finny_algorithm_set_params",
    "finny_algorithm_validate",
    "finny_extract_data",
    "finny_backtest_run",
    "finny_backtest_walkforward",
    "finny_backtest_sweep",
    "finny_algorithm_export",
    "finny_portfolio_backtest",
  ])

  export function isRestrictedTool(id: string) {
    return RESTRICTED_TOOL_IDS.has(id)
  }

  export function hashLicenseKey(rawKey: string) {
    return sha256(rawKey.trim())
  }

  export async function machineIdHash() {
    const userId = await DeviceProfile.userId()
    return sha256(userId)
  }

  export async function isUnlockedForToday() {
    if (isBypassEnabled()) return true
    const cache = await readCache()
    if (!cache || !isFresh(cache)) return false
    return cache.org_id === orgId() && cache.machine_id_hash === (await machineIdHash())
  }

  export async function currentStatus() {
    const cache = await readCache()
    const machineHash = await machineIdHash()
    return {
      active: isBypassEnabled() || (!!cache && cache.org_id === orgId() && cache.machine_id_hash === machineHash && isFresh(cache)),
      org_id: cache?.org_id ?? orgId(),
      plan_type: cache?.plan_type,
      license_key_hash: cache?.license_key_hash,
      machine_id_hash: machineHash,
      cached_machine_id_hash: cache?.machine_id_hash,
      last_ok_at: cache?.last_ok_at,
      next_check_after: cache?.next_check_after,
      devices_used: cache?.devices_used,
      device_limit: cache?.device_limit,
    }
  }

  export async function activate(rawKey: string): Promise<void> {
    const key = rawKey.trim()
    if (!key) throw new AccessDeniedError()
    const org = orgId()
    const licenseKeyHash = hashLicenseKey(key)
    const machineHash = await machineIdHash()
    const result = await checkRemote(org, licenseKeyHash, machineHash)
    if (!result.ok) throw new AccessDeniedError(result.message)
    await writeCache({ orgID: org, licenseKeyHash, machineIdHash: machineHash, result })
  }

  export async function ensureActive(): Promise<void> {
    if (isBypassEnabled()) return

    const cache = await readCache()
    const currentMachineHash = await machineIdHash()
    const envKey = process.env.FINNY_LICENSE_KEY?.trim()
    if (cache && cache.org_id === orgId() && isFresh(cache) && cache.machine_id_hash === currentMachineHash) {
      if (!envKey || cache.license_key_hash === hashLicenseKey(envKey)) return
    }

    if (envKey) {
      await activate(envKey)
      return
    }

    if (!cache) throw new AccessDeniedError()

    const result = await checkRemote(orgId(), cache.license_key_hash, currentMachineHash)
    if (!result.ok) throw new AccessDeniedError(result.message)
    await writeCache({
      orgID: orgId(),
      licenseKeyHash: cache.license_key_hash,
      machineIdHash: currentMachineHash,
      result,
    })
  }

  async function parseCheckResponse(response: Response): Promise<CheckResult | undefined> {
    const text = await response.text().catch(() => "")
    if (!text.trim()) return undefined
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed
    } catch {}
    return undefined
  }

  async function checkRemote(orgID: string, licenseKeyHash: string, machineIdHash: string): Promise<CheckResult> {
    const url = checkUrl()
    if (!url) throw new VerificationError("License check URL is not configured.")

    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgID,
          license_key_hash: licenseKeyHash,
          machine_id_hash: machineIdHash,
          app_version: InstallationVersion,
          timestamp: new Date(nowImpl()).toISOString(),
        }),
      })
    } catch {
      throw new VerificationError()
    }

    const parsed = await parseCheckResponse(response)
    if (response.status === 200) {
      if (parsed?.ok === true) return parsed
      throw new VerificationError()
    }
    if (response.status === 403) {
      if (parsed?.ok === false) return parsed
      return { ok: false }
    }
    throw new VerificationError()
  }

  export function _resetForTests() {
    fetchImpl = globalThis.fetch.bind(globalThis)
    nowImpl = () => Date.now()
    cacheDirOverride = undefined
  }

  export function _setFetchForTests(next: typeof fetch) {
    fetchImpl = next
  }

  export function _setNowForTests(next: () => number) {
    nowImpl = next
  }

  export function _setCacheDirForTests(next: string) {
    cacheDirOverride = next
  }
}
