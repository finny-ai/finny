import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LeanAdapter } from "../../src/backtest/lean/adapter"
import {
  isLeanCertifiedSync,
  isLeanEnabledSync,
  leanConfigStatus,
  leanAdapterCertSync,
  setLeanEnabled,
  LEAN_ADAPTER_CERT_VALUE,
} from "../../src/backtest/lean/lean-config"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalLeanEnabled = process.env.FINNY_LEAN_ENABLED
const originalLeanCert = process.env.FINNY_LEAN_ADAPTER_CERT
const originalConfigFile = process.env.FINNY_LEAN_CONFIG_FILE
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-lean-config-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_LEAN_CONFIG_FILE = path.join(home, "lean-config.json")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalLeanEnabled === undefined) delete process.env.FINNY_LEAN_ENABLED
  else process.env.FINNY_LEAN_ENABLED = originalLeanEnabled
  if (originalLeanCert === undefined) delete process.env.FINNY_LEAN_ADAPTER_CERT
  else process.env.FINNY_LEAN_ADAPTER_CERT = originalLeanCert
  if (originalConfigFile === undefined) delete process.env.FINNY_LEAN_CONFIG_FILE
  else process.env.FINNY_LEAN_CONFIG_FILE = originalConfigFile
})

describe("native LEAN engine config", () => {
  test("defaults to enabled and certified without any setting or env", async () => {
    isolatedHome()
    const status = await leanConfigStatus()
    expect(status.enabled).toBe(true)
    expect(status.adapterCert).toBe(LEAN_ADAPTER_CERT_VALUE)
    expect(status.effective).toBe(true)
    expect(status.source).toBe("default")
    expect(isLeanEnabledSync()).toBe(true)
    expect(isLeanCertifiedSync()).toBe(true)
    expect(new LeanAdapter().probeReady().ready).toBe(true)
  })

  test("explicit FINNY_LEAN_ENABLED=0 still force-disables the native default", async () => {
    isolatedHome()
    expect(isLeanEnabledSync()).toBe(true)
    process.env.FINNY_LEAN_ENABLED = "0"
    expect(isLeanEnabledSync()).toBe(false)
    expect(new LeanAdapter().probeReady().ready).toBe(false)
    expect(new LeanAdapter().probeReady().reasons.join(" ")).toContain("disabled")
  })

  test("enable persists and pins the certified adapter certificate", async () => {
    isolatedHome()
    await setLeanEnabled(true)
    const status = await leanConfigStatus()
    expect(status.enabled).toBe(true)
    expect(status.adapterCert).toBe(LEAN_ADAPTER_CERT_VALUE)
    expect(status.adapterCert === LEAN_ADAPTER_CERT_VALUE).toBe(true)
    expect(status.source).toBe("setting")
    expect(isLeanEnabledSync()).toBe(true)
    expect(isLeanCertifiedSync()).toBe(true)
    expect(leanAdapterCertSync()).toBe(LEAN_ADAPTER_CERT_VALUE)
  })

  test("disable clears the certificate", async () => {
    isolatedHome()
    await setLeanEnabled(true)
    await setLeanEnabled(false)
    const status = await leanConfigStatus()
    expect(status.enabled).toBe(false)
    expect(status.adapterCert).toBeNull()
    expect(isLeanEnabledSync()).toBe(false)
  })

  test("environment override wins over the persisted setting", async () => {
    isolatedHome()
    await setLeanEnabled(false)
    process.env.FINNY_LEAN_ENABLED = "1"
    process.env.FINNY_LEAN_ADAPTER_CERT = LEAN_ADAPTER_CERT_VALUE
    const status = await leanConfigStatus()
    expect(status.enabled).toBe(true)
    expect(status.source).toBe("env")
    expect(status.effective).toBe(true)
    expect(new LeanAdapter().probeReady().ready).toBe(true)
  })

  test("enabling without the certified cert still reports not ready", async () => {
    isolatedHome()
    await setLeanEnabled(true)
    process.env.FINNY_LEAN_ADAPTER_CERT = "some-other-cert"
    expect(new LeanAdapter().probeReady().ready).toBe(false)
    expect(new LeanAdapter().probeReady().reasons.join(" ")).toContain("certificate")
  })
})
