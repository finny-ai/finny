import { ConvexControlAccounts } from "@/storage/convex/control-accounts"
import z from "zod"

export namespace Control {
  export const Account = z.object({
    email: z.string(),
    url: z.string(),
  })
  export type Account = z.infer<typeof Account>

  export async function account(): Promise<Account | undefined> {
    const row = await ConvexControlAccounts.getActive()
    if (!row) return undefined
    return {
      email: row.email,
      url: row.url,
    }
  }

  export async function token(): Promise<string | undefined> {
    const row = await ConvexControlAccounts.getActive()
    if (!row) return undefined
    if (row.token_expiry && row.token_expiry > Date.now()) return row.access_token

    const res = await fetch(`${row.url}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
      }).toString(),
    })

    if (!res.ok) return

    const json = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    await ConvexControlAccounts.updateTokens({
      email: row.email,
      url: row.url,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      token_expiry: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    })

    return json.access_token
  }
}
