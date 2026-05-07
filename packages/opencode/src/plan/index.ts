import crypto from "crypto"
import { Auth } from "@/auth"

// Ed25519 public key for license verification.
// The matching private key lives on your server (finnyai.tech) and is used
// to sign license codes after Stripe payment. Never ship the private key.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFhylJyaYOMYUg2FDV+oJa3yU9mUEg4b5ZHPM0qJsUcI=
-----END PUBLIC KEY-----`

export namespace Plan {
  export type Tier = "free" | "lite" | "pro"

  export const TIER_RANK: Record<Tier, number> = { free: 0, lite: 1, pro: 2 }

  export const PRO_PROVIDER_ID = "finny-pro"
  export const LITE_PROVIDER_ID = "finny-lite"
  // Back-compat alias — older code referenced Plan.PROVIDER_ID.
  export const PROVIDER_ID = PRO_PROVIDER_ID

  // Single source of truth for the upgrade CTA. DialogHelp, the welcome card,
  // and any future paywall reference this — change in one place if marketing
  // moves the page.
  export const UPGRADE_URL = "https://www.finnyai.tech/pro"

  export const SAVE_CAP: Record<Tier, number> = {
    free: 5,
    lite: 15,
    pro: Number.POSITIVE_INFINITY,
  }

  export const DAILY_BACKTEST_LIMIT: Record<Tier, number> = {
    free: 10,
    lite: 20,
    pro: Number.POSITIVE_INFINITY,
  }

  export const TERMINAL_RUN_CAP: Record<Tier, number> = {
    free: 2,
    lite: 5,
    pro: Number.POSITIVE_INFINITY,
  }

  export const CLOUD_RUN_CAP: Record<Tier, number> = {
    free: 0,
    lite: 3,
    pro: 5,
  }

  const PRO_KEY_PREFIX = "FINNY-PRO-"
  const LITE_KEY_PREFIX = "FINNY-LITE-"

  /**
   * Validate a license key format and cryptographic signature.
   *
   * Key format: FINNY-{TIER}-<uuid>.<base64url_signature>
   *
   * The <uuid> is the payload, signed with Ed25519 using the private key.
   * Verification uses the embedded public key — no network call needed.
   */
  function verifySignature(key: string, prefix: string): boolean {
    if (!key.startsWith(prefix)) return false

    const withoutPrefix = key.slice(prefix.length)
    const dotIndex = withoutPrefix.lastIndexOf(".")
    if (dotIndex === -1) return false

    const payload = withoutPrefix.slice(0, dotIndex)
    const signatureB64 = withoutPrefix.slice(dotIndex + 1)

    if (!payload || !signatureB64) return false

    try {
      const pubKey = crypto.createPublicKey(PUBLIC_KEY)
      const signature = Buffer.from(signatureB64, "base64url")
      return crypto.verify(null, Buffer.from(payload), pubKey, signature)
    } catch {
      return false
    }
  }

  /** Detect which tier a pasted code claims based on its prefix. Does NOT verify the signature. */
  export function detectTier(key: string): Exclude<Tier, "free"> | null {
    if (key.startsWith(PRO_KEY_PREFIX)) return "pro"
    if (key.startsWith(LITE_KEY_PREFIX)) return "lite"
    return null
  }

  function prefixFor(tier: Exclude<Tier, "free">): string {
    return tier === "pro" ? PRO_KEY_PREFIX : LITE_KEY_PREFIX
  }

  function providerIdFor(tier: Exclude<Tier, "free">): string {
    return tier === "pro" ? PRO_PROVIDER_ID : LITE_PROVIDER_ID
  }

  async function readSlot(tier: Exclude<Tier, "free">): Promise<string | null> {
    const info = await Auth.get(providerIdFor(tier))
    if (!info || info.type !== "api") return null
    return info.key
  }

  /** Returns the highest valid tier the user has activated. */
  export async function getTier(): Promise<Tier> {
    const proKey = await readSlot("pro")
    if (proKey && verifySignature(proKey, PRO_KEY_PREFIX)) return "pro"
    const liteKey = await readSlot("lite")
    if (liteKey && verifySignature(liteKey, LITE_KEY_PREFIX)) return "lite"
    return "free"
  }

  export function hasAtLeast(current: Tier, required: Tier): boolean {
    return TIER_RANK[current] >= TIER_RANK[required]
  }

  export async function meetsTier(required: Tier): Promise<boolean> {
    return hasAtLeast(await getTier(), required)
  }

  /** Throws PlanLimitError if the current tier is below `required`. */
  export async function requireTier(required: Tier, feature: string): Promise<void> {
    const current = await getTier()
    if (!hasAtLeast(current, required)) {
      throw new PlanLimitError({ current, required, feature })
    }
  }

  /** Back-compat: returns true when the user has at least Pro. */
  export async function isPro(): Promise<boolean> {
    return meetsTier("pro")
  }

  /** Get the active license key for a given tier slot, masked for display. */
  export async function getLicenseKey(tier: Exclude<Tier, "free"> = "pro"): Promise<string | null> {
    return readSlot(tier)
  }

  /**
   * Persist a pasted license code into the slot matching its prefix.
   * Returns the detected tier, or null if the prefix is unknown.
   * (Signature is NOT validated here — call getTier() afterwards to confirm.)
   */
  export async function setLicenseKey(key: string): Promise<Exclude<Tier, "free"> | null> {
    const tier = detectTier(key)
    if (!tier) return null
    await Auth.set(providerIdFor(tier), { type: "api", key })
    return tier
  }

  /** Remove the license code for a specific tier slot. Other slots untouched. */
  export async function removeLicenseKey(tier: Exclude<Tier, "free"> = "pro"): Promise<void> {
    await Auth.remove(providerIdFor(tier))
  }

  export function maskKey(key: string): string {
    if (key.length <= 16) return key.slice(0, 8) + "..."
    return key.slice(0, 12) + "..." + key.slice(-4)
  }

  export type PlanLimitDetail = {
    current: Tier
    required: Tier
    feature: string
  }

  export class PlanLimitError extends Error {
    readonly code = "PLAN_LIMIT" as const
    readonly current: Tier
    readonly required: Tier
    readonly feature: string

    constructor(detail: PlanLimitDetail) {
      const upgrade = detail.required === "pro" ? "Finny Pro" : "Finny Lite"
      super(
        `Plan limit reached for "${detail.feature}". Upgrade to ${upgrade} (current: ${detail.current}).`,
      )
      this.name = "PlanLimitError"
      this.current = detail.current
      this.required = detail.required
      this.feature = detail.feature
    }

    toJSON() {
      return {
        code: this.code,
        current: this.current,
        required: this.required,
        feature: this.feature,
        message: this.message,
      }
    }
  }
}
