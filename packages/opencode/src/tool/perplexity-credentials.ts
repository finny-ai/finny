import { Auth } from "@/auth"

export const PERPLEXITY_PROVIDER_ID = "perplexity"

/**
 * Resolve the Perplexity API key the same way brokerage credentials work:
 * process env first, then the locally stored auth.json entry under
 * provider id `perplexity` (Settings → Providers / Data Sources → Web search).
 */
export async function resolvePerplexityApiKey(): Promise<string> {
  const fromEnv = process.env.PERPLEXITY_API_KEY?.trim()
  if (fromEnv) return fromEnv

  try {
    const auth = await Auth.get(PERPLEXITY_PROVIDER_ID)
    if (auth?.type === "api") {
      const key = auth.key.trim()
      if (key) return key
    }
  } catch {
    // Missing or unreadable auth store is treated as no key.
  }
  return ""
}

export async function hasPerplexityApiKey(): Promise<boolean> {
  return (await resolvePerplexityApiKey()).length > 0
}

export function maskPerplexityKey(key: string): string {
  if (!key) return ""
  if (key.length <= 8) return key
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
