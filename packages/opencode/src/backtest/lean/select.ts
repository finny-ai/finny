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
}

export function runtimeFromConfig(configJson: string | undefined | null): RuntimeConfigV1 {
  let config: Record<string, any> = {}
  try {
    config = JSON.parse(configJson ?? "{}") as Record<string, any>
  } catch {
    config = {}
  }
  const runtime = config?.runtime
  if (runtime && typeof runtime === "object") {
    const nested = runtime.profile && typeof runtime.profile === "object" ? runtime.profile : undefined
    const rawProfileId = nested?.profileId ?? runtime.profileId
    const profileId: FinnyRuntimeId = rawProfileId === "lean_python" || rawProfileId === "lean_csharp"
      ? rawProfileId
      : "finny_python"
    const profile: RuntimeProfileV1 = {
      schema: "finny.runtime_profile",
      version: 1,
      profileId,
      profileHash:
        typeof nested?.profileHash === "string"
          ? nested.profileHash
          : typeof runtime.profileHash === "string"
            ? runtime.profileHash
            : runtimeProfileV1(profileId).profileHash,
    }
    const source =
      nested?.source && typeof nested.source === "object"
        ? (nested.source as StrategySourceV1)
        : runtime.source && typeof runtime.source === "object"
          ? (runtime.source as StrategySourceV1)
          : undefined
    return { profile, source }
  }
  return { profile: runtimeProfileV1("finny_python") }
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
  return isLeanProfile(runtimeForCandidate(candidate).profile)
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
