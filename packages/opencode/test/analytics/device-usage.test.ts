import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Telemetry } from "@/analytics/gate"
import { TelemetrySink } from "@/analytics/sink"
import { UsageTracker } from "@/analytics/usage"
import { DeviceRegister, detectInstallMethod } from "@/device/register"

let batches: any[][] = []

beforeEach(() => {
  batches = []
  Telemetry._resetForTests()
  Telemetry._setForTests(true)
  TelemetrySink._resetForTests()
  UsageTracker._resetForTests()
  DeviceRegister._resetForTests()
  TelemetrySink._setFetchForTests((async (_input: any, init: any) => {
    batches.push(JSON.parse(String(init?.body)).batch)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch)
})

afterEach(() => {
  UsageTracker._resetForTests()
  DeviceRegister._resetForTests()
  TelemetrySink._resetForTests()
  Telemetry._resetForTests()
})

describe("detectInstallMethod", () => {
  test.each([
    ["/Users/x/.opencode/bin/finny", "curl"],
    ["/home/x/.local/bin/finny", "curl"],
    ["/Users/x/.bun/bin/finny", "bun"],
    ["/opt/homebrew/Cellar/finny/1.0/bin/finny", "brew"],
    ["/usr/local/lib/node_modules/finny/bin/finny", "npm"],
    ["/somewhere/else/finny", "unknown"],
  ])("%s -> %s", (execPath, expected) => {
    expect(detectInstallMethod(execPath)).toBe(expected)
  })
})

describe("DeviceRegister", () => {
  test("ships a device row with install provenance once", async () => {
    DeviceRegister.register()
    DeviceRegister.register()
    await Bun.sleep(20)
    await TelemetrySink.flush()
    await TelemetrySink.drain()
    const devices = batches.flat().filter((e) => e.kind === "device")
    expect(devices).toHaveLength(1)
    expect(devices[0].hostname.length).toBeGreaterThan(0)
    expect(devices[0].platform).toBe(process.platform)
    expect(typeof devices[0].installMethod).toBe("string")
  })
})

describe("UsageTracker", () => {
  test("start emits a heartbeat and stop stamps endedAt on the same runId", async () => {
    UsageTracker.start("test-surface")
    await UsageTracker.stop()
    const beats = batches.flat().filter((e) => e.kind === "usage")
    expect(beats.length).toBeGreaterThanOrEqual(2)
    expect(beats[0].surface).toBe("test-surface")
    expect(beats[0].endedAt).toBeUndefined()
    const last = beats[beats.length - 1]
    expect(last.runId).toBe(beats[0].runId)
    expect(typeof last.endedAt).toBe("number")
    expect(last.lastActiveAt).toBeGreaterThanOrEqual(last.startedAt)
  })

  test("does nothing when telemetry is disabled", async () => {
    Telemetry._setForTests(false)
    Telemetry.disable()
    UsageTracker.start("test-surface")
    await UsageTracker.stop()
    expect(batches.flat().filter((e) => e.kind === "usage")).toHaveLength(0)
  })
})
