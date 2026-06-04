import { internalMutation } from "./_generated/server"
import { v } from "convex/values"

const HASH_RE = /^[a-f0-9]{64}$/i
const ORG_RE = /^[a-z0-9_-]{1,64}$/
const DEFAULT_PER_HEAD_DEVICE_LIMIT = 2
const NEXT_CHECK_MS = 24 * 60 * 60 * 1000

type PlanType = "enterprise" | "per_head"
type LicenseCheck = {
  machine_id_hash: string
  result: "allowed" | "denied"
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

function activeMachineHashes(checks: LicenseCheck[]) {
  const machines = new Set<string>()
  for (const check of checks) {
    if (check.result === "allowed") machines.add(check.machine_id_hash)
  }
  return machines
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

    const historicalChecks = await ctx.db
      .query("licenseChecks")
      .withIndex("by_org_license", (q) =>
        q.eq("org_id", args.org_id).eq("license_key_hash", args.license_key_hash),
      )
      .collect()

    const machines = activeMachineHashes(historicalChecks)
    const currentMachineAlreadyAllowed = machines.has(args.machine_id_hash)
    let devicesUsed = machines.size

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
      await ctx.db.patch(license._id, { time_updated: now })
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
      return result
    }

    if (license.status === "revoked") return deny("revoked")
    if (license.status !== "active") return deny("expired")
    if (license.active_from !== undefined && license.active_from > now) return deny("expired")
    if (license.active_until !== undefined && license.active_until < now) return deny("expired")

    if (license.plan_type === "enterprise") {
      devicesUsed = currentMachineAlreadyAllowed ? devicesUsed : devicesUsed + 1
    } else if (!currentMachineAlreadyAllowed) {
      if (devicesUsed >= deviceLimit!) return deny("device_limit_reached", devicesUsed)
      devicesUsed += 1
    }

    const result = response({
      ok: true,
      plan_type: license.plan_type,
      devices_used: devicesUsed,
      device_limit: deviceLimit,
      now,
    })

    await recordCheck({
      result: "allowed",
      devicesUsed,
      deviceLimit,
    })
    return result
  },
})
