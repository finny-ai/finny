import crypto from "node:crypto"

/** Engine runtime identifiers known to the Finny backtest control plane. */
export type FinnyRuntimeId = "finny_python" | "lean_python" | "lean_csharp"

export const LEAN_RUNTIME_IDS: readonly FinnyRuntimeId[] = ["lean_python", "lean_csharp"]

export const LEAN_IMAGE_REF = "ghcr.io/finny-ai/lean-engine"
export const LEAN_PINNED_COMMIT = "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0"

/** Placeholder pinned digest; replaced when the Finny engine image is published. */
export const LEAN_PINNED_IMAGE_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

/** Runtime profile bound to one saved algorithm version. */
export interface RuntimeProfileV1 {
  schema: "finny.runtime_profile"
  version: 1
  profileId: FinnyRuntimeId
  profileHash: string
}

/** Safe file manifest for LEAN strategy source trees. */
export interface StrategySourceV1 {
  schema: "finny.strategy_source"
  version: 1
  profileId: "lean_python" | "lean_csharp"
  files: Array<{
    path: string
    sha256: string
    bytes: number
  }>
  sourceTreeHash: string
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function stableHash(value: unknown): string {
  if (value === null || typeof value !== "object") return sha256Text(JSON.stringify(value))
  if (Array.isArray(value)) return sha256Text(`[${value.map(stableHash).join(",")}]`)
  return sha256Text(
    `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableHash(item)}`)
      .join(",")}}`,
  )
}

export function runtimeProfileV1(profileId: FinnyRuntimeId): RuntimeProfileV1 {
  return {
    schema: "finny.runtime_profile",
    version: 1,
    profileId,
    profileHash: stableHash({ schema: "finny.runtime_profile", version: 1, profileId }),
  }
}

export function isLeanProfile(profile: RuntimeProfileV1 | undefined | null): profile is RuntimeProfileV1 & { profileId: "lean_python" | "lean_csharp" } {
  return Boolean(profile && LEAN_RUNTIME_IDS.includes(profile.profileId))
}

export function strategySourceTreeHash(files: StrategySourceV1["files"]): string {
  return stableHash(files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })))
}

export function isSafeSourcePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

export function strategySourceV1(input: {
  profileId: "lean_python" | "lean_csharp"
  files: Array<{ path: string; sha256: string; bytes: number }>
}): StrategySourceV1 {
  const unsafe = input.files.find((f) => !isSafeSourcePath(f.path))
  if (unsafe) throw new Error(`unsafe strategy source path: ${unsafe.path}`)
  const sourceTreeHash = strategySourceTreeHash(input.files)
  return { schema: "finny.strategy_source", version: 1, profileId: input.profileId, files: input.files, sourceTreeHash }
}

export interface LeanExecutionProfileV1 {
  schema: "finny.lean_execution_profile"
  version: 1
  fillPolicy: "next_eligible_bar_open"
  allowedOrderTypes: ["market", "limit", "stop_market"]
  fillForwardEnabled: false
  normalizationMode: "raw"
  volumeParticipationCapPct: number
  tickLotRounding: "canonical"
  fees: { makerFeeBps: number; takerFeeBps: number }
  slippageBps: number
  buyingPower: { maxLeverage: number; maintenanceMarginPct: number }
  shortingEnabled: boolean
  settlement: "t2_equity" | "instant_crypto"
  dataFeedWorkers: number
  executionProfileHash: string
}

export function leanExecutionProfileV1(input: {
  assetClass: "equity" | "crypto_spot"
  makerFeeBps: number
  takerFeeBps: number
  slippageBps: number
  maxLeverage: number
  maintenanceMarginPct: number
  shortingEnabled: boolean
  dataFeedWorkers: number
}): LeanExecutionProfileV1 {
  const draft: Omit<LeanExecutionProfileV1, "executionProfileHash"> = {
    schema: "finny.lean_execution_profile",
    version: 1,
    fillPolicy: "next_eligible_bar_open",
    allowedOrderTypes: ["market", "limit", "stop_market"],
    fillForwardEnabled: false,
    normalizationMode: "raw",
    volumeParticipationCapPct: 0.1,
    tickLotRounding: "canonical",
    fees: { makerFeeBps: input.makerFeeBps, takerFeeBps: input.takerFeeBps },
    slippageBps: input.slippageBps,
    buyingPower: { maxLeverage: input.maxLeverage, maintenanceMarginPct: input.maintenanceMarginPct },
    shortingEnabled: input.shortingEnabled,
    settlement: input.assetClass === "equity" ? "t2_equity" : "instant_crypto",
    dataFeedWorkers: input.dataFeedWorkers,
  }
  return { ...draft, executionProfileHash: stableHash(draft) }
}

export function verifyExecutionProfile(profile: LeanExecutionProfileV1): string[] {
  const errors: string[] = []
  if (profile.schema !== "finny.lean_execution_profile" || profile.version !== 1) return ["unsupported execution profile"]
  if (profile.fillPolicy !== "next_eligible_bar_open") errors.push("fill policy must be next_eligible_bar_open")
  if (profile.fillForwardEnabled !== false) errors.push("fill-forward must be disabled")
  if (profile.normalizationMode !== "raw") errors.push("normalization mode must be raw")
  if (profile.volumeParticipationCapPct <= 0 || profile.volumeParticipationCapPct > 1) {
    errors.push("volume participation cap must be in (0,1]")
  }
  if (profile.tickLotRounding !== "canonical") errors.push("tick/lot rounding must be canonical")
  if (profile.fees.makerFeeBps < 0 || profile.fees.takerFeeBps < 0) errors.push("fees must be non-negative")
  if (profile.slippageBps < 0) errors.push("slippage must be non-negative")
  if (profile.buyingPower.maxLeverage <= 0) errors.push("max leverage must be positive")
  if (profile.buyingPower.maintenanceMarginPct < 0 || profile.buyingPower.maintenanceMarginPct > 1) {
    errors.push("maintenance margin must be in [0,1]")
  }
  if (profile.dataFeedWorkers < 1) errors.push("data feed workers must be at least 1")
  return errors
}

export interface LeanImageIdentityV1 {
  schema: "finny.lean_image_identity"
  version: 1
  imageRef: string
  imageDigest: string
  leanCommit: string
  architectures: Array<"linux/amd64" | "linux/arm64">
  sbomSha256: string
  provenanceSha256: string
}

export interface LeanRuntimeBundleV1 {
  schema: "finny.lean_runtime_bundle"
  version: 1
  profile: RuntimeProfileV1
  source: StrategySourceV1
  executionProfile: LeanExecutionProfileV1
  image: LeanImageIdentityV1
  leanConfigHash: string
  adapterHash: string
  runtimeHash: string
}

export function leanRuntimeBundleV1(input: {
  profile: RuntimeProfileV1
  source: StrategySourceV1
  executionProfile: LeanExecutionProfileV1
  image: LeanImageIdentityV1
  leanConfig: string
  adapterHash: string
}): LeanRuntimeBundleV1 {
  if (!isLeanProfile(input.profile)) throw new Error("runtime bundle requires a LEAN profile")
  if (input.profile.profileId !== input.source.profileId) throw new Error("source profile does not match runtime profile")
  const leanConfigHash = sha256Text(input.leanConfig)
  const runtimeHash = stableHash({
    profile: input.profile,
    source: input.source,
    executionProfile: input.executionProfile,
    image: input.image,
    leanConfigHash,
    adapterHash: input.adapterHash,
  })
  return {
    schema: "finny.lean_runtime_bundle",
    version: 1,
    profile: input.profile,
    source: input.source,
    executionProfile: input.executionProfile,
    image: input.image,
    leanConfigHash,
    adapterHash: input.adapterHash,
    runtimeHash,
  }
}
