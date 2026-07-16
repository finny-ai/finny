// Consumer telemetry is ON BY DEFAULT.
// Opt out by setting FINNY_TELEMETRY=0 (or OPENCODE_TELEMETRY=0 / "false" /
// "off").
function envDisabled(): boolean {
  const value = (process.env["FINNY_TELEMETRY"] ?? process.env["OPENCODE_TELEMETRY"])?.toLowerCase()
  return value === "0" || value === "false" || value === "off"
}

function localDevSuppressed(): boolean {
  if (process.env["FINNY_TELEMETRY_ALLOW_DEV"] === "1") return false
  if (process.env["FINNY_TELEMETRY_DEV_MODE"] === "1") return true
  return process.env["npm_lifecycle_event"]?.startsWith("dev") === true
}

let enabledCached: boolean | undefined
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
    enabledCached = false
  }

  // Human-readable reason telemetry is on/off, for startup diagnostics.
  export function statusReason(): string {
    if (forcedOff) return "disabled via config (analytics: disabled)"
    if (envDisabled()) return "opted out via FINNY_TELEMETRY/OPENCODE_TELEMETRY"
    if (localDevSuppressed())
      return "suppressed in local dev (npm_lifecycle_event=dev); set FINNY_TELEMETRY_ALLOW_DEV=1 to enable"
    return "enabled"
  }

  export async function refresh(): Promise<boolean> {
    enabledCached = !suppressed()
    return enabledCached
  }

  export async function enabledAsync(): Promise<boolean> {
    if (suppressed()) return false
    if (enabledCached !== undefined) return enabledCached
    if (!pending) pending = refresh().finally(() => (pending = undefined))
    return pending
  }

  export function enabled(): boolean {
    if (suppressed()) return false
    if (enabledCached === undefined) {
      if (!pending) pending = refresh().finally(() => (pending = undefined))
      return false
    }
    return enabledCached === true
  }

  export function _resetForTests() {
    enabledCached = undefined
    pending = undefined
    forcedOff = false
  }

  export function _setForTests(value: boolean | undefined) {
    enabledCached = value
  }
}
