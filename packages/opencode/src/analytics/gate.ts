import { License } from "../license"

function envSwitch(): boolean {
  return process.env["FINNY_TELEMETRY"] === "1" || process.env["OPENCODE_TELEMETRY"] === "1"
}

function localDevSuppressed(): boolean {
  if (process.env["FINNY_TELEMETRY_ALLOW_DEV"] === "1") return false
  if (process.env["FINNY_TELEMETRY_DEV_MODE"] === "1") return true
  return process.env["npm_lifecycle_event"]?.startsWith("dev") === true
}

let consumerCached: boolean | undefined
let pending: Promise<boolean> | undefined
let forcedOff = false

// Telemetry is globally off when force-disabled, not opted in via env, or
// suppressed in local dev. Early returns keep this free of a compound
// conditional so each gate check stays a single predicate.
function suppressed(): boolean {
  if (forcedOff) return true
  if (!envSwitch()) return true
  return localDevSuppressed()
}

export namespace Telemetry {
  export function switchEnabled(): boolean {
    return envSwitch() && !localDevSuppressed()
  }

  export function disable() {
    forcedOff = true
    consumerCached = false
  }

  export async function refresh(): Promise<boolean> {
    if (suppressed()) {
      consumerCached = false
      return false
    }
    try {
      consumerCached = await License.isConsumer()
    } catch {
      consumerCached = false
    }
    return consumerCached
  }

  export async function enabledAsync(): Promise<boolean> {
    if (suppressed()) return false
    if (consumerCached !== undefined) return consumerCached
    if (!pending) pending = refresh().finally(() => (pending = undefined))
    return pending
  }

  export function enabled(): boolean {
    if (suppressed()) return false
    if (consumerCached === undefined) {
      if (!pending) pending = refresh().finally(() => (pending = undefined))
      return false
    }
    return consumerCached === true
  }

  export function _resetForTests() {
    consumerCached = undefined
    pending = undefined
    forcedOff = false
  }

  export function _setForTests(value: boolean | undefined) {
    consumerCached = value
  }
}
