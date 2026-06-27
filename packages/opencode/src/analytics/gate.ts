import { License } from "../license"

// Consumer telemetry is ON BY DEFAULT for per_head (Plus/Pro) licenses.
// Opt out by setting FINNY_TELEMETRY=0 (or OPENCODE_TELEMETRY=0 / "false" /
// "off"). The per_head license gate (see refresh) is the privacy boundary:
// enterprise/non-consumer keys never emit regardless of this switch.
function envDisabled(): boolean {
  const value = (process.env["FINNY_TELEMETRY"] ?? process.env["OPENCODE_TELEMETRY"])?.toLowerCase()
  return value === "0" || value === "false" || value === "off"
}

function localDevSuppressed(): boolean {
  if (process.env["FINNY_TELEMETRY_ALLOW_DEV"] === "1") return false
  if (process.env["FINNY_TELEMETRY_DEV_MODE"] === "1") return true
  return process.env["npm_lifecycle_event"]?.startsWith("dev") === true
}

let consumerCached: boolean | undefined
let pending: Promise<boolean> | undefined
let forcedOff = false

// Telemetry is globally off when force-disabled, explicitly opted out via env,
// or suppressed in local dev. Early returns keep this free of a compound
// conditional so each gate check stays a single predicate.
function suppressed(): boolean {
  if (forcedOff) return true
  if (envDisabled()) return true
  return localDevSuppressed()
}

export namespace Telemetry {
  export function switchEnabled(): boolean {
    return !envDisabled() && !localDevSuppressed()
  }

  export function disable() {
    forcedOff = true
    consumerCached = false
  }

  // Human-readable reason telemetry is on/off, for startup diagnostics. Call
  // after refresh() so the consumer-license check is reflected.
  export function statusReason(): string {
    if (forcedOff) return "disabled via config (analytics: disabled)"
    if (envDisabled()) return "opted out via FINNY_TELEMETRY/OPENCODE_TELEMETRY"
    if (localDevSuppressed())
      return "suppressed in local dev (npm_lifecycle_event=dev); set FINNY_TELEMETRY_ALLOW_DEV=1 to enable"
    if (consumerCached === false) return "license is not an active per_head consumer license"
    if (consumerCached === undefined) return "license status not resolved yet"
    return "enabled"
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
