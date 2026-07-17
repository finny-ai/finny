import os from "os"
import crypto from "crypto"
import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

const log = Log.create({ service: "device" })

const STATE_DIR_ENV = "FINNY_STATE_DIR"
let stateDirOverride: string | undefined

interface DeviceInfo {
  userId: string
  hostname: string
  username: string
  platform: string
  arch: string
}

let cached: DeviceInfo | undefined

function stateDir() {
  const envDir = process.env[STATE_DIR_ENV]?.trim()
  return stateDirOverride ?? (envDir || Global.Path.data)
}

function deviceFile() {
  return path.join(stateDir(), "device.json")
}

export namespace DeviceProfile {
  export type Info = DeviceInfo

  export async function get(): Promise<DeviceInfo> {
    if (cached) return cached

    let existing: Partial<DeviceInfo> | undefined
    try {
      existing = await Filesystem.readJson<Partial<DeviceInfo>>(deviceFile())
    } catch {
      // First run — no file yet
    }

    const userId = existing?.userId || crypto.randomUUID()
    const info: DeviceInfo = {
      userId,
      hostname: os.hostname(),
      username: os.userInfo().username,
      platform: process.platform,
      arch: process.arch,
    }

    // Write back (creates dir if missing, updates volatile fields)
    try {
      await Filesystem.writeJson(deviceFile(), info)
    } catch (e) {
      log.warn("failed to write device profile", { error: e })
    }

    cached = info
    return info
  }

  /**
   * Canonical user ID for this install. This is the ONE source for the value
   * we hang telemetry and session ownership off of — `Analytics.track` uses
   * it to populate `interactions.userId`, and the session-sync writer uses it
   * to populate `sessions.user_id`. Anywhere else that needs "who owns this
   * row" should call this function rather than rolling its own getter.
   *
   * Stable across runs (persisted in `device.json`); first call on a fresh
   * machine generates a v4 UUID.
   */
  export async function userId(): Promise<string> {
    const info = await get()
    return info.userId
  }

  export function _resetForTests() {
    cached = undefined
    stateDirOverride = undefined
  }

  export function _setStateDirForTests(next: string) {
    cached = undefined
    stateDirOverride = next
  }
}
