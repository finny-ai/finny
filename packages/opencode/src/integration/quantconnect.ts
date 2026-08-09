import { Auth } from "@/auth"
import fs from "node:fs"
import path from "node:path"

export const QC_PROVIDER_ID = "quantconnect"
export const QC_AUTHENTICATE_URL = "https://www.quantconnect.com/api/v2/authenticate"
export const QC_API_BASE = "https://www.quantconnect.com/api/v2"

export interface QcCredentials {
  userId: string
  apiToken: string
}

export interface QcVerifiedIdentity {
  connected: true
  userId: string
  name: string
}

export interface QcConnectionState {
  connected: boolean
  /** True when running without real QC credentials against the local fixture path. */
  fixture?: boolean
  userId?: string
  name?: string
  error?: string
}

export function isQcFixtureMode(): boolean {
  return process.env.QC_FIXTURE === "1" || process.env.FINNY_QC_FIXTURE === "1"
}

export async function readQcCredentials(): Promise<QcCredentials | null> {
  const info = await Auth.get(QC_PROVIDER_ID)
  if (!info || info.type !== "api") return null
  const userId = (info as any).metadata?.userId
  if (!userId || !info.key) return null
  return { userId, apiToken: info.key }
}

/**
 * Verify QC API credentials against QuantConnect's authentication endpoint.
 * The credentials are validated BEFORE anything is stored.
 */
export async function verifyQcCredentials(input: QcCredentials): Promise<QcVerifiedIdentity> {
  const response = await fetch(QC_AUTHENTICATE_URL, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${input.userId}:${input.apiToken}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || body.success !== true) {
    throw new Error(
      `QuantConnect authentication failed (HTTP ${response.status}): ${String(body.message ?? body.error ?? "invalid credentials")}`,
    )
  }
  return {
    connected: true,
    userId: input.userId,
    name: String(body.name ?? input.userId),
  }
}

export async function connectQcCredentials(input: QcCredentials): Promise<QcVerifiedIdentity> {
  const verified = await verifyQcCredentials(input)
  await Auth.set(QC_PROVIDER_ID, {
    type: "api",
    key: input.apiToken,
    metadata: { userId: input.userId },
  })
  return verified
}

export async function disconnectQcCredentials(): Promise<void> {
  await Auth.remove(QC_PROVIDER_ID)
}

export async function qcConnectionState(): Promise<QcConnectionState> {
  if (isQcFixtureMode()) {
    return {
      connected: false,
      fixture: true,
      name: "QuantConnect fixture (no credentials required)",
    }
  }
  const credentials = await readQcCredentials()
  if (!credentials) return { connected: false }
  try {
    const verified = await verifyQcCredentials(credentials)
    return { connected: true, userId: verified.userId, name: verified.name }
  } catch (error) {
    return {
      connected: false,
      userId: credentials.userId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Synchronous best-effort presence check for the capability manifest.
 * Mirrors Auth.all()'s source: OPENCODE_AUTH_CONTENT first, then auth.json.
 */
export function qcCredentialPresentSync(): boolean {
  let data: Record<string, unknown>
  try {
    if (process.env.OPENCODE_AUTH_CONTENT) {
      data = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
    } else {
      const file = path.join(process.env.FINNY_HOME ?? "", "data", "auth.json")
      if (process.env.FINNY_HOME && !fs.existsSync(file)) return false
      const fallback = path.join(process.env.HOME ?? "/tmp", ".local", "share", "finny", "data", "auth.json")
      const authFile = fs.existsSync(file) ? file : fallback
      if (!fs.existsSync(authFile)) return false
      data = JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, unknown>
    }
  } catch {
    return false
  }
  const entry = data[QC_PROVIDER_ID]
  return Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "api")
}
