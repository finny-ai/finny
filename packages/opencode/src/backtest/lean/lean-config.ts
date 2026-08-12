import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"

/**
 * Native LEAN engine configuration.
 *
 * LEAN is a first-class Finny engine and is enabled by default with the
 * certified adapter — no opt-in or environment activation is required. The
 * user can disable it from Settings or the CLI (`lean disable`), and the
 * choice is persisted. Environment variables remain a test/harness override
 * and always win.
 *
 * The adapter certificate is a supply-chain pin: only the certified adapter
 * value may be recorded. Enabling LEAN always writes the pinned certificate.
 */

export const LEAN_ADAPTER_CERT_ENV = "FINNY_LEAN_ADAPTER_CERT"
export const LEAN_ADAPTER_CERT_VALUE = "finny-lean-adapter-cert-v1"

export interface LeanConfigV1 {
  schema: "finny.lean_config"
  version: 1
  enabled: boolean
  adapterCert: string | null
  updatedAt: number
}

export function leanConfigFile(): string {
  return process.env.FINNY_LEAN_CONFIG_FILE ?? path.join(Global.Path.data, "lean-config.json")
}

async function readConfig(): Promise<LeanConfigV1 | null> {
  try {
    const raw = JSON.parse(await fs.readFile(leanConfigFile(), "utf8")) as LeanConfigV1
    if (raw?.schema !== "finny.lean_config" || raw.version !== 1) return null
    return raw
  } catch {
    return null
  }
}

async function writeConfig(config: LeanConfigV1): Promise<void> {
  const file = leanConfigFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

/** In-process cache so sync consumers (capability manifest, probe) see the setting. */
const cache: { loaded: boolean; enabled: boolean; adapterCert: string | null } = {
  loaded: false,
  enabled: true,
  adapterCert: LEAN_ADAPTER_CERT_VALUE,
}

/** Load the persisted setting into the process cache (daemon/server startup). */
export async function loadLeanConfig(): Promise<void> {
  const config = await readConfig()
  cache.loaded = true
  // Native default: a fresh install has LEAN enabled and certified. Only an
  // explicit persisted decision (or env override) changes that.
  cache.enabled = config === null ? true : config.enabled === true
  cache.adapterCert = config === null ? LEAN_ADAPTER_CERT_VALUE : config.adapterCert ?? null
}

/** Persist and apply a LEAN enable/disable decision. */
export async function setLeanEnabled(enabled: boolean): Promise<LeanConfigV1> {
  const previous = await readConfig()
  const config: LeanConfigV1 = {
    schema: "finny.lean_config",
    version: 1,
    enabled,
    adapterCert: enabled ? LEAN_ADAPTER_CERT_VALUE : null,
    updatedAt: Date.now(),
  }
  await writeConfig(config)
  cache.loaded = true
  cache.enabled = enabled
  cache.adapterCert = config.adapterCert
  return { ...previous, ...config }
}

/** Effective LEAN enablement: env override (tests/harness) > persisted setting > native default. */
export function isLeanEnabledSync(): boolean {
  const env = process.env.FINNY_LEAN_ENABLED?.toLowerCase()
  if (env === "1" || env === "true") return true
  // The override is symmetric: an explicit "0"/"false" must force-disable
  // even when the native default (or persisted setting) enabled LEAN.
  if (env === "0" || env === "false") return false
  return cache.loaded ? cache.enabled : true
}

/** Effective adapter certificate: env override > persisted setting. */
export function leanAdapterCertSync(): string | null {
  const env = process.env[LEAN_ADAPTER_CERT_ENV]
  if (env !== undefined && env !== "") return env
  return cache.loaded ? cache.adapterCert : null
}

/** True when the certified adapter is effective and matches the pin. */
export function isLeanCertifiedSync(): boolean {
  return leanAdapterCertSync() === LEAN_ADAPTER_CERT_VALUE
}

export async function leanConfigStatus(): Promise<{
  enabled: boolean
  effective: boolean
  adapterCert: string | null
  source: "env" | "setting" | "default"
}> {
  await loadLeanConfig()
  const envEnabled = isLeanEnabledSync() && leanAdapterCertSync() !== null
  const enabled = isLeanEnabledSync()
  const cert = leanAdapterCertSync()
  return {
    enabled,
    effective: enabled && cert === LEAN_ADAPTER_CERT_VALUE,
    adapterCert: cert,
    source: process.env.FINNY_LEAN_ENABLED ? "env" : cache.loaded && (await readConfig()) ? "setting" : "default",
  }
}
