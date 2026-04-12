import crypto from "crypto"
import { Auth } from "@/auth"

// Ed25519 public key for license verification.
// The matching private key lives on your server (finnyai.tech) and is used
// to sign license codes after Stripe payment. Never ship the private key.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFhylJyaYOMYUg2FDV+oJa3yU9mUEg4b5ZHPM0qJsUcI=
-----END PUBLIC KEY-----`

export namespace Plan {
  export const PROVIDER_ID = "finny-pro"
  const KEY_PREFIX = "FINNY-PRO-"

  /**
   * Validate a license key format and cryptographic signature.
   *
   * Key format: FINNY-PRO-<uuid>.<base64url_signature>
   *
   * The <uuid> is the payload, signed with Ed25519 using the private key.
   * Verification uses the embedded public key — no network call needed.
   */
  function verifySignature(key: string): boolean {
    if (!key.startsWith(KEY_PREFIX)) return false

    const withoutPrefix = key.slice(KEY_PREFIX.length)
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

  export async function getLicenseKey(): Promise<string | null> {
    const info = await Auth.get(PROVIDER_ID)
    if (!info || info.type !== "api") return null
    return info.key
  }

  export async function isPro(): Promise<boolean> {
    const key = await getLicenseKey()
    if (!key) return false
    return verifySignature(key)
  }

  export async function setLicenseKey(key: string): Promise<void> {
    await Auth.set(PROVIDER_ID, { type: "api", key })
  }

  export async function removeLicenseKey(): Promise<void> {
    await Auth.remove(PROVIDER_ID)
  }

  export function maskKey(key: string): string {
    if (key.length <= 16) return key.slice(0, 8) + "..."
    return key.slice(0, 12) + "..." + key.slice(-4)
  }
}
