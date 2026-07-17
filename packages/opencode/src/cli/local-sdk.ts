import { createOpencodeClient } from "@opencode-ai/sdk/v2"

export async function localFetch(input: RequestInfo | URL, init?: RequestInit) {
  const { Server } = await import("@/server/server")
  const request = new Request(input, init)
  return Server.Default().app.fetch(request)
}

export function createLocalSdk(directory?: string) {
  return createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: localFetch as typeof globalThis.fetch,
    directory,
  })
}
