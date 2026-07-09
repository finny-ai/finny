import crypto from "crypto"
import path from "path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { DeviceProfile } from "@/device"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"

const CACHE_FILE = "license-cache.json"
const TERMS_FILE = "terms-acceptance.json"
const LICENSE_STATE_DIR_ENV = "FINNY_LICENSE_STATE_DIR"
const GRACE_MS = 24 * 60 * 60 * 1000

// Bump when the Terms / License Agreement materially change so users are
// re-prompted to accept the new version.
const TERMS_VERSION = "2026-06-22"
const TERMS_URL = "https://finnyai.tech/legal/eula"

type TermsAcceptance = {
  version: string
  accepted_at: string
}
const DEFAULT_CHECK_URL = "https://api.finnyai.tech/v1/license/check"
const DEFAULT_CLIENT_ID = "finny-pro"

type PlanType = "per_head" | "enterprise"

type Cache = {
  schema_version?: 1 | 2
  org_id?: string
  org_name?: string
  plan_type?: PlanType
  license_key_hash: string
  machine_id_hash: string
  last_ok_at: string
  next_check_after?: string
}

type CheckOk = {
  ok: true
  orgId?: string
  orgName?: string
  plan_type?: PlanType
  planType?: PlanType
  deviceLimitReached?: boolean
  message?: string
  nextCheckAfter?: string
}

type CheckDenied = {
  ok: false
  orgId?: string
  orgName?: string
  deviceLimitReached?: boolean
  message?: string
  nextCheckAfter?: string
}

type CheckResult = CheckOk | CheckDenied

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
let nowImpl = () => Date.now()
let cacheDirOverride: string | undefined

function stateDir() {
  const envDir = process.env[LICENSE_STATE_DIR_ENV]?.trim()
  return cacheDirOverride ?? (envDir || Global.Path.data)
}

function cachePath() {
  return path.join(stateDir(), CACHE_FILE)
}

function termsPath() {
  return path.join(stateDir(), TERMS_FILE)
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function extractPlanType(result?: CheckOk): PlanType | undefined {
  const value = result?.plan_type ?? result?.planType
  return value === "per_head" || value === "enterprise" ? value : undefined
}

function isBypassEnabled() {
  const value = process.env.FINNY_LICENSE_BYPASS
  return value === "1" || value?.toLowerCase() === "true"
}

function checkUrl() {
  return process.env.FINNY_LICENSE_CHECK_URL?.trim() || DEFAULT_CHECK_URL
}

function clientId() {
  return process.env.FINNY_LICENSE_CLIENT?.trim() || DEFAULT_CLIENT_ID
}

function isFresh(cache: Cache, now = nowImpl()) {
  const lastOk = Date.parse(cache.last_ok_at)
  return Number.isFinite(lastOk) && now - lastOk < GRACE_MS
}

async function readCache(): Promise<Cache | null> {
  try {
    const cache = await Filesystem.readJson<Cache>(cachePath())
    if (!cache.license_key_hash || !cache.machine_id_hash || !cache.last_ok_at) return null
    return cache
  } catch {
    return null
  }
}

async function writeCache(input: { licenseKeyHash: string; machineIdHash: string; result?: CheckOk }) {
  await Filesystem.writeJson(
    cachePath(),
    {
      schema_version: 2,
      org_id: input.result?.orgId,
      org_name: input.result?.orgName,
      plan_type: extractPlanType(input.result),
      license_key_hash: input.licenseKeyHash,
      machine_id_hash: input.machineIdHash,
      last_ok_at: new Date(nowImpl()).toISOString(),
      next_check_after: input.result?.nextCheckAfter,
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
    "finny_workspace_prepare",
    "finny_backtest",
    "finny_paper_approve",
    "finny_backtest_sweep",
    "finny_algorithm_export",
    "finny_portfolio_backtest",
  ])

  export function isRestrictedTool(id: string) {
    return RESTRICTED_TOOL_IDS.has(id)
  }

  export const termsVersion = TERMS_VERSION
  export const termsUrl = TERMS_URL

  /** True if the user has already accepted the current Terms / License version. */
  export async function hasAcceptedTerms(): Promise<boolean> {
    try {
      const record = await Filesystem.readJson<TermsAcceptance>(termsPath())
      return record?.version === TERMS_VERSION
    } catch {
      return false
    }
  }

  /** Persist that the user accepted the current Terms / License version. */
  export async function recordTermsAcceptance(): Promise<void> {
    await Filesystem.writeJson(
      termsPath(),
      {
        version: TERMS_VERSION,
        accepted_at: new Date(nowImpl()).toISOString(),
      } satisfies TermsAcceptance,
      0o600,
    )
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
    return cache.machine_id_hash === (await machineIdHash())
  }

  export async function currentStatus() {
    const cache = await readCache()
    const machineHash = await machineIdHash()
    return {
      active: isBypassEnabled() || (!!cache && cache.machine_id_hash === machineHash && isFresh(cache)),
      org_id: cache?.org_id,
      org_name: cache?.org_name,
      plan_type: cache?.plan_type,
      license_key_hash: cache?.license_key_hash,
      machine_id_hash: machineHash,
      cached_machine_id_hash: cache?.machine_id_hash,
      last_ok_at: cache?.last_ok_at,
      next_check_after: cache?.next_check_after,
    }
  }

  export async function plan(): Promise<PlanType | undefined> {
    const cache = await readCache()
    if (!cache || !isFresh(cache)) return undefined
    if (cache.machine_id_hash !== (await machineIdHash())) return undefined
    return cache.plan_type
  }

  export async function isConsumer(): Promise<boolean> {
    return (await plan()) === "per_head"
  }

  export async function activate(rawKey: string): Promise<void> {
    const key = rawKey.trim()
    if (!key) throw new AccessDeniedError()
    const licenseKeyHash = hashLicenseKey(key)
    const machineHash = await machineIdHash()
    const result = await checkRemote(licenseKeyHash, machineHash)
    if (!result.ok) throw new AccessDeniedError(result.message)
    await writeCache({ licenseKeyHash, machineIdHash: machineHash, result })
  }

  export async function ensureActive(): Promise<void> {
    if (isBypassEnabled()) return

    const cache = await readCache()
    const currentMachineHash = await machineIdHash()
    const envKey = process.env.FINNY_LICENSE_KEY?.trim()
    if (cache && isFresh(cache) && cache.machine_id_hash === currentMachineHash) {
      if (!envKey || cache.license_key_hash === hashLicenseKey(envKey)) return
    }

    if (envKey) {
      await activate(envKey)
      return
    }

    if (!cache) throw new AccessDeniedError()

    const result = await checkRemote(cache.license_key_hash, currentMachineHash)
    if (!result.ok) throw new AccessDeniedError(result.message)
    await writeCache({
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

  async function checkRemote(licenseKeyHash: string, machineIdHash: string): Promise<CheckResult> {
    const url = checkUrl()
    if (!url) throw new VerificationError("License check URL is not configured.")

    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          licenseKeyHash,
          machineIdHash,
          appVersion: InstallationVersion,
          client: clientId(),
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
