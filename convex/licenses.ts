import { internalMutation } from "./_generated/server"
import { v } from "convex/values"

const HASH_RE = /^[a-f0-9]{64}$/i
const ORG_RE = /^[a-z0-9_-]{1,64}$/
const CHECK_LIMIT = 100
const DEFAULT_PER_HEAD_DEVICE_LIMIT = 2
const NEXT_CHECK_MS = 24 * 60 * 60 * 1000

type PlanType = "enterprise" | "per_head"
type Device = {
  machine_id_hash: string
  status: "active" | "revoked"
  first_seen_at: number
  last_seen_at: number
}
type Check = {
  timestamp: number
  result: "allowed" | "denied"
  error_code?: string
  app_version?: string
  machine_id_hash?: string
  devices_used?: number
  device_limit?: number
}

function validHash(value: string) {
  return HASH_RE.test(value)
}

function validOrg(value: string) {
  return ORG_RE.test(value)
}

function nextCheckAfter(now: number) {
  return new Date(now + NEXT_CHECK_MS).toISOString()
}

function userMessage(errorCode: string) {
  if (errorCode === "expired") return "This Finny license has expired. Please contact Finny."
  if (errorCode === "revoked") return "This Finny license has been revoked. Please contact Finny."
  if (errorCode === "device_limit_reached") {
    return "This license is already active on the maximum number of devices."
  }
  return "Access denied. Please contact Finny."
}

function withCheck(existing: Check[] | undefined, check: Check) {
  return [...(existing ?? []), check].slice(-CHECK_LIMIT)
}

function activeDevices(devices: Device[]) {
  return devices.filter((device) => device.status === "active")
}

function response(input: {
  ok: boolean
  plan_type?: PlanType
  error_code?: string
  devices_used?: number
  device_limit?: number
  now: number
}) {
  if (input.ok) {
    return {
      ok: true,
      plan_type: input.plan_type,
      devices_used: input.devices_used,
      device_limit: input.device_limit,
      next_check_after: nextCheckAfter(input.now),
    }
  }
  return {
    ok: false,
    error_code: input.error_code ?? "invalid_license",
    message: userMessage(input.error_code ?? "invalid_license"),
    devices_used: input.devices_used,
    device_limit: input.device_limit,
  }
}

export const check = internalMutation({
  args: {
    request_id: v.string(),
    org_id: v.string(),
    license_key_hash: v.string(),
    machine_id_hash: v.string(),
    app_version: v.optional(v.string()),
    timestamp: v.number(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const db = (ctx as any).db
    const now = Date.now()

    if (!validOrg(args.org_id) || !validHash(args.license_key_hash) || !validHash(args.machine_id_hash)) {
      return response({ ok: false, error_code: "invalid_license", now })
    }

    const license = await db
      .query("licenses")
      .withIndex("by_org_license_key_hash", (q: any) =>
        q.eq("org_id", args.org_id).eq("license_key_hash", args.license_key_hash),
      )
      .unique()

    if (!license) return response({ ok: false, error_code: "invalid_license", now })

    const devices = (license.devices ?? []) as Device[]
    const deviceLimit =
      license.plan_type === "per_head"
        ? Math.max(1, Number(license.max_devices_per_key ?? DEFAULT_PER_HEAD_DEVICE_LIMIT))
        : undefined

    const deny = async (errorCode: string, devicesUsed = activeDevices(devices).length) => {
      const result = response({
        ok: false,
        plan_type: license.plan_type,
        error_code: errorCode,
        devices_used: devicesUsed,
        device_limit: deviceLimit,
        now,
      })
      await db.patch(license._id, {
        checks: withCheck(license.checks, {
          timestamp: now,
          result: "denied",
          error_code: errorCode,
          app_version: args.app_version,
          machine_id_hash: args.machine_id_hash,
          devices_used: devicesUsed,
          device_limit: deviceLimit,
        }),
        time_updated: now,
      })
      return result
    }

    if (license.status === "revoked") return deny("revoked")
    if (license.status !== "active") return deny("expired")
    if (license.active_from !== undefined && license.active_from > now) return deny("expired")
    if (license.active_until !== undefined && license.active_until < now) return deny("expired")

    const existingIndex = devices.findIndex((device) => device.machine_id_hash === args.machine_id_hash)
    const existing = existingIndex >= 0 ? devices[existingIndex] : undefined
    let nextDevices = devices
    let devicesUsed = activeDevices(devices).length

    if (existing?.status === "active") {
      nextDevices = devices.map((device, index) =>
        index === existingIndex ? { ...device, last_seen_at: now } : device,
      )
    } else if (license.plan_type === "enterprise") {
      nextDevices =
        existingIndex >= 0
          ? devices.map((device, index) =>
              index === existingIndex ? { ...device, status: "active", last_seen_at: now } : device,
            )
          : [
              ...devices,
              {
                machine_id_hash: args.machine_id_hash,
                status: "active",
                first_seen_at: now,
                last_seen_at: now,
              },
            ]
      devicesUsed = activeDevices(nextDevices).length
    } else {
      if (devicesUsed >= deviceLimit!) return deny("device_limit_reached", devicesUsed)
      nextDevices =
        existingIndex >= 0
          ? devices.map((device, index) =>
              index === existingIndex ? { ...device, status: "active", last_seen_at: now } : device,
            )
          : [
              ...devices,
              {
                machine_id_hash: args.machine_id_hash,
                status: "active",
                first_seen_at: now,
                last_seen_at: now,
              },
            ]
      devicesUsed = activeDevices(nextDevices).length
    }

    const result = response({
      ok: true,
      plan_type: license.plan_type,
      devices_used: devicesUsed,
      device_limit: deviceLimit,
      now,
    })

    await db.patch(license._id, {
      devices: nextDevices,
      checks: withCheck(license.checks, {
        timestamp: now,
        result: "allowed",
        app_version: args.app_version,
        machine_id_hash: args.machine_id_hash,
        devices_used: devicesUsed,
        device_limit: deviceLimit,
      }),
      time_updated: now,
    })
    return result
  },
})
