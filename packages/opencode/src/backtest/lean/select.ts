import type { Algorithm } from "@/algorithm"
import {
  isLeanProfile,
  runtimeProfileV1,
  strategySourceV1,
  type FinnyRuntimeId,
  type RuntimeProfileV1,
  type StrategySourceV1,
} from "./contracts"

export interface RuntimeConfigV1 {
  profile: RuntimeProfileV1
  source?: StrategySourceV1
  /**
   * Runtime declarations are additive for legacy candidates, but once a
   * candidate explicitly declares one it must never be coerced back to the
   * default engine. Callers must fail closed when this list is non-empty.
   */
  issues: string[]
  explicitlyConfigured: boolean
}

export function runtimeFromConfig(configJson: string | undefined | null): RuntimeConfigV1 {
  let config: Record<string, any> = {}
  try {
    config = JSON.parse(configJson ?? "{}") as Record<string, any>
  } catch {
    return {
      profile: runtimeProfileV1("finny_python"),
      issues: ["candidate config is not valid JSON; runtime selection cannot be trusted"],
      explicitlyConfigured: false,
    }
  }
  const runtime = config?.runtime
  if (runtime !== undefined) {
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      return {
        profile: runtimeProfileV1("finny_python"),
        issues: ["runtime must be an object containing a supported runtime profile"],
        explicitlyConfigured: true,
      }
    }
    const nested = runtime.profile && typeof runtime.profile === "object" ? runtime.profile : undefined
    const rawProfileId = nested?.profileId ?? runtime.profileId
    const supported: readonly FinnyRuntimeId[] = ["finny_python", "lean_python", "lean_csharp", "qc_cloud"]
    const profileId = typeof rawProfileId === "string" && supported.includes(rawProfileId as FinnyRuntimeId)
      ? (rawProfileId as FinnyRuntimeId)
      : undefined
    if (!profileId) {
      return {
        profile: runtimeProfileV1("finny_python"),
        issues: [`unsupported runtime profile ${JSON.stringify(rawProfileId ?? null)}`],
        explicitlyConfigured: true,
      }
    }
    const expectedProfile = runtimeProfileV1(profileId)
    const suppliedProfileHash = nested?.profileHash ?? runtime.profileHash
    const issues: string[] = []
    if (suppliedProfileHash !== undefined && suppliedProfileHash !== expectedProfile.profileHash) {
      issues.push(`runtime profile hash does not match profile ${profileId}`)
    }
    const profile: RuntimeProfileV1 = {
      schema: "finny.runtime_profile",
      version: 1,
      profileId,
      profileHash: expectedProfile.profileHash,
    }
    const source =
      nested?.source && typeof nested.source === "object"
        ? (nested.source as StrategySourceV1)
        : runtime.source && typeof runtime.source === "object"
          ? (runtime.source as StrategySourceV1)
          : undefined
    return { profile, source, issues, explicitlyConfigured: true }
  }
  return { profile: runtimeProfileV1("finny_python"), issues: [], explicitlyConfigured: false }
}

export function runtimeForCandidate(candidate: Pick<Algorithm.Info, "config">): RuntimeConfigV1 {
  return runtimeFromConfig(candidate.config)
}

export function embedRuntimeConfig(input: {
  config: string | undefined | null
  profileId: FinnyRuntimeId
  sourceFiles?: Array<{ path: string; sha256: string; bytes: number }>
}): string {
  let config: Record<string, any> = {}
  try {
    config = JSON.parse(input.config ?? "{}") as Record<string, any>
  } catch {
    config = {}
  }
  const profile = runtimeProfileV1(input.profileId)
  const runtime: Record<string, any> = { profile }
  if (input.profileId === "lean_python" || input.profileId === "lean_csharp") {
    const source = strategySourceV1({
      profileId: input.profileId,
      files: input.sourceFiles ?? [],
    })
    runtime.source = source
  }
  config.runtime = runtime
  return JSON.stringify(config)
}

export function isLeanCandidate(candidate: Pick<Algorithm.Info, "config">): boolean {
  const runtime = runtimeForCandidate(candidate)
  if (runtime.issues.length > 0) throw new Error(runtime.issues.join("; "))
  return isLeanProfile(runtime.profile)
}

export function validateLeanSourceManifest(source: StrategySourceV1 | undefined, profileId: string): string[] {
  const errors: string[] = []
  if (!source) {
    return ["LEAN runtimes require a strategy source manifest (strategySource) with the exact project files"]
  }
  if (source.schema !== "finny.strategy_source" || source.version !== 1) {
    errors.push("strategy source manifest has an unsupported schema")
  }
  if (source.profileId !== profileId) {
    errors.push(`strategy source manifest profile ${source.profileId} does not match runtime ${profileId}`)
  }
  if (!source.files || source.files.length === 0) {
    errors.push("strategy source manifest must contain at least one file")
  }
  for (const file of source.files ?? []) {
    if (!/^[a-f0-9]{64}$/i.test(file.sha256)) errors.push(`file ${file.path} has an invalid sha256`)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) errors.push(`file ${file.path} has invalid byte count`)
    const allowed = profileId === "lean_csharp" ? /\.cs$/ : /\.py$/
    if (!allowed.test(file.path)) {
      errors.push(`file ${file.path} is not allowed for runtime ${profileId}`)
    }
  }
  if (source.sourceTreeHash && !/^[a-f0-9]{64}$/i.test(source.sourceTreeHash)) {
    errors.push("source tree hash is invalid")
  }
  return errors
}
