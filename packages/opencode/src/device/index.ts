import os from "os"
import crypto from "crypto"
import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

const log = Log.create({ service: "device" })

const DEVICE_FILE = path.join(Global.Path.data, "device.json")

interface DeviceInfo {
  userId: string
  hostname: string
  username: string
  platform: string
  arch: string
}

let cached: DeviceInfo | undefined

export namespace DeviceProfile {
  export type Info = DeviceInfo

  export async function get(): Promise<DeviceInfo> {
    if (cached) return cached

    let existing: Partial<DeviceInfo> | undefined
    try {
      existing = await Filesystem.readJson<Partial<DeviceInfo>>(DEVICE_FILE)
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
      await Filesystem.writeJson(DEVICE_FILE, info)
    } catch (e) {
      log.warn("failed to write device profile", { error: e })
    }

    cached = info
    return info
  }

  export async function userId(): Promise<string> {
    const info = await get()
    return info.userId
  }
}
