import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { isQcFixtureMode, qcConnectionState, resolveQcMode, connectQcCredentials } from "../../src/integration/quantconnect"
import { readQcModeSetting, setConfiguredQcMode } from "../../src/integration/qc-store"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalFinnyFixture = process.env.FINNY_QC_FIXTURE
const originalControl = process.env.FINNY_QC_CONTROL_DIR
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-qc-mode-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_CONTROL_DIR = path.join(home, "qc-control")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
  if (originalFinnyFixture === undefined) delete process.env.FINNY_QC_FIXTURE
  else process.env.FINNY_QC_FIXTURE = originalFinnyFixture
  if (originalControl === undefined) delete process.env.FINNY_QC_CONTROL_DIR
  else process.env.FINNY_QC_CONTROL_DIR = originalControl
})

describe("QC track mode (native local/cloud switch)", () => {
  test("defaults to cloud without any setting or env", async () => {
    isolatedHome()
    const mode = await resolveQcMode()
    expect(mode.mode).toBe("cloud")
    expect(mode.configured).toBe("cloud")
    expect(mode.source).toBe("default")
    expect(await isQcFixtureMode()).toBe(false)
  })

  test("persists a fixture-mode switch and honors it on later reads", async () => {
    isolatedHome()
    await setConfiguredQcMode("fixture")
    expect(await readQcModeSetting()).toBe("fixture")
    const mode = await resolveQcMode()
    expect(mode.mode).toBe("fixture")
    expect(mode.source).toBe("setting")
    expect(await isQcFixtureMode()).toBe(true)
  })

  test("switches back to cloud and the fixture flag clears", async () => {
    isolatedHome()
    await setConfiguredQcMode("fixture")
    expect(await isQcFixtureMode()).toBe(true)
    await setConfiguredQcMode("cloud")
    expect(await isQcFixtureMode()).toBe(false)
    expect((await resolveQcMode()).source).toBe("setting")
  })

  test("environment override wins over the persisted setting", async () => {
    isolatedHome()
    await setConfiguredQcMode("cloud")
    process.env.QC_FIXTURE = "1"
    const mode = await resolveQcMode()
    expect(mode.mode).toBe("fixture")
    expect(mode.source).toBe("env")
    expect(await isQcFixtureMode()).toBe(true)
    delete process.env.QC_FIXTURE
    expect(await isQcFixtureMode()).toBe(false)
  })

  test("connection state reports the fixture mode and source", async () => {
    isolatedHome()
    await setConfiguredQcMode("fixture")
    const state = await qcConnectionState()
    expect(state.fixture).toBe(true)
    expect(state.connected).toBe(false)
    expect(state.mode?.mode).toBe("fixture")
    expect(state.mode?.source).toBe("setting")
  })

  test("connecting credentials fails closed while in fixture mode", async () => {
    isolatedHome()
    await setConfiguredQcMode("fixture")
    await expect(
      connectQcCredentials({ userId: "1", apiToken: "token" }),
    ).rejects.toThrow(/local fixture mode/)
  })
})
