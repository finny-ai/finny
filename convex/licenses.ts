import { internalMutation } from "./_generated/server"
import { v } from "convex/values"

const HASH_RE = /^[a-f0-9]{64}$/i
const ORG_RE = /^[a-z0-9_-]{1,64}$/
const DEFAULT_PER_HEAD_DEVICE_LIMIT = 2
const NEXT_CHECK_MS = 24 * 60 * 60 * 1000

type PlanType = "enterprise" | "per_head"
type LicenseCheck = {
  machine_id_hash: string
  status: "active" | "revoked"
  first_seen_at: number
  last_seen_at: number
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
    return "Access denied. Already configured on 2 devices."
  }
  return "Access denied. Please contact Finny."
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

function activeDevices(devices: LicenseCheck[]) {
  return devices.filter((device) => device.status === "active")
}

function upsertDevice(devices: LicenseCheck[], machineHash: string, now: number) {
  const existingIndex = devices.findIndex((device) => device.machine_id_hash === machineHash)
  if (existingIndex >= 0) {
    return devices.map((device, index) =>
      index === existingIndex
        ? {
            ...device,
            status: "active" as const,
            last_seen_at: now,
          }
        : device,
    )
  }
  return [
    ...devices,
    {
      machine_id_hash: machineHash,
      status: "active" as const,
      first_seen_at: now,
      last_seen_at: now,
    },
  ]
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
    const now = Date.now()

    if (!validOrg(args.org_id) || !validHash(args.license_key_hash) || !validHash(args.machine_id_hash)) {
      return response({ ok: false, error_code: "invalid_license", now })
    }

    const license = await ctx.db
      .query("licenses")
      .withIndex("by_org_license_key_hash", (q) =>
        q.eq("org_id", args.org_id).eq("license_key_hash", args.license_key_hash),
      )
      .unique()

    if (!license) return response({ ok: false, error_code: "invalid_license", now })

    const deviceLimit =
      license.plan_type === "per_head"
        ? Math.max(1, Number(license.max_devices_per_key ?? DEFAULT_PER_HEAD_DEVICE_LIMIT))
        : undefined

    const devices = (license.devices ?? []) as LicenseCheck[]
    const currentDevice = devices.find((device) => device.machine_id_hash === args.machine_id_hash)
    const currentMachineAlreadyAllowed = currentDevice?.status === "active"
    let nextDevices = devices
    let devicesUsed = activeDevices(devices).length

    const recordCheck = async (input: {
      result: "allowed" | "denied"
      errorCode?: string
      devicesUsed?: number
      deviceLimit?: number
    }) => {
      await ctx.db.insert("licenseChecks", {
        request_id: args.request_id,
        org_id: args.org_id,
        license_key_hash: args.license_key_hash,
        machine_id_hash: args.machine_id_hash,
        app_version: args.app_version,
        result: input.result,
        error_code: input.errorCode,
        devices_used: input.devicesUsed,
        device_limit: input.deviceLimit,
        metadata: args.metadata,
        timestamp: now,
      })
    }

    const deny = async (errorCode: string, currentDevicesUsed = devicesUsed) => {
      const result = response({
        ok: false,
        plan_type: license.plan_type,
        error_code: errorCode,
        devices_used: currentDevicesUsed,
        device_limit: deviceLimit,
        now,
      })
      await recordCheck({
        result: "denied",
        errorCode,
        devicesUsed: currentDevicesUsed,
        deviceLimit,
      })
      await ctx.db.patch(license._id, { time_updated: now })
      return result
    }

    if (license.status === "revoked") return deny("revoked")
    if (license.status !== "active") return deny("expired")
    if (license.active_from !== undefined && license.active_from > now) return deny("expired")
    if (license.active_until !== undefined && license.active_until < now) return deny("expired")

    if (license.plan_type === "enterprise") {
      nextDevices = upsertDevice(devices, args.machine_id_hash, now)
      devicesUsed = activeDevices(nextDevices).length
    } else if (currentMachineAlreadyAllowed) {
      nextDevices = upsertDevice(devices, args.machine_id_hash, now)
    } else if (!currentMachineAlreadyAllowed) {
      if (devicesUsed >= deviceLimit!) return deny("device_limit_reached", devicesUsed)
      nextDevices = upsertDevice(devices, args.machine_id_hash, now)
      devicesUsed = activeDevices(nextDevices).length
    }

    const result = response({
      ok: true,
      plan_type: license.plan_type,
      devices_used: devicesUsed,
      device_limit: deviceLimit,
      now,
    })

    await ctx.db.patch(license._id, {
      devices: nextDevices,
      time_updated: now,
    })
    await recordCheck({
      result: "allowed",
      devicesUsed,
      deviceLimit,
    })
    return result
  },
})

export const issue = internalMutation({
  args: {
    org_id: v.string(),
    license_key_hash: v.string(),
    plan_type: v.union(v.literal("enterprise"), v.literal("per_head")),
    max_devices_per_key: v.optional(v.number()),
    tier: v.optional(v.string()),
    email: v.optional(v.string()),
    source: v.optional(v.string()),
    source_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const licenseKeyHash = args.license_key_hash.toLowerCase()

    if (!validOrg(args.org_id) || !validHash(args.license_key_hash)) {
      return { ok: false, error_code: "invalid_license" }
    }

    const activePatch = {
      plan_type: args.plan_type,
      status: "active" as const,
      time_updated: now,
      ...(args.max_devices_per_key !== undefined ? { max_devices_per_key: args.max_devices_per_key } : {}),
      ...(args.source !== undefined ? { source: args.source } : {}),
      ...(args.source_id !== undefined ? { source_id: args.source_id } : {}),
      ...(args.tier !== undefined ? { tier: args.tier } : {}),
      ...(args.email !== undefined ? { email: args.email } : {}),
    }

    if (args.source_id) {
      const existingBySource = await ctx.db
        .query("licenses")
        .withIndex("by_source_id", (q) => q.eq("source_id", args.source_id))
        .first()

      if (existingBySource) {
        await ctx.db.patch(existingBySource._id, activePatch)
        return { ok: true, license_id: existingBySource._id, deduped: true }
      }
    }

    const existingByHash = await ctx.db
      .query("licenses")
      .withIndex("by_org_license_key_hash", (q) =>
        q.eq("org_id", args.org_id).eq("license_key_hash", licenseKeyHash),
      )
      .unique()

    if (existingByHash) {
      await ctx.db.patch(existingByHash._id, activePatch)
      return { ok: true, license_id: existingByHash._id, deduped: true }
    }

    const licenseId = await ctx.db.insert("licenses", {
      org_id: args.org_id,
      license_key_hash: licenseKeyHash,
      plan_type: args.plan_type,
      status: "active",
      max_devices_per_key: args.max_devices_per_key,
      source: args.source,
      source_id: args.source_id,
      tier: args.tier,
      email: args.email,
      devices: [],
      time_created: now,
      time_updated: now,
    })

    return { ok: true, license_id: licenseId, deduped: false }
  },
})

export const revoke = internalMutation({
  args: {
    source_id: v.string(),
  },
  handler: async (ctx, args) => {
    const sourceId = args.source_id.trim()
    if (!sourceId) return { ok: false, error_code: "invalid_source_id" }

    const license = await ctx.db
      .query("licenses")
      .withIndex("by_source_id", (q) => q.eq("source_id", sourceId))
      .first()

    if (!license) return { ok: true, revoked: false, missing: true }
    if (license.status === "revoked") return { ok: true, revoked: false, deduped: true }

    await ctx.db.patch(license._id, {
      status: "revoked",
      time_updated: Date.now(),
    })

    return { ok: true, revoked: true }
  },
})
