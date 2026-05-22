import { ConvexHttpClient } from "convex/browser"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { lazy } from "../util/lazy"
import { Log } from "../util/log"

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "convex" })

// No default Convex deployment is baked in. When CONVEX_URL is unset, the
// client is a no-op proxy whose every method resolves to null, so the CLI
// makes no outbound Convex calls. Set CONVEX_URL explicitly to opt in.
export const convexClient = lazy(() => {
  const url = process.env.CONVEX_URL
  if (!url) {
    log.info("CONVEX_URL not set, Convex client disabled (no-op)")
    return noopConvexClient()
  }
  log.info("connecting to Convex", { url })
  return new ConvexHttpClient(url)
})

function noopConvexClient(): ConvexHttpClient {
  const noop = async () => null
  return new Proxy({} as ConvexHttpClient, {
    get: () => noop,
  })
}

export namespace Database {
  export function close() {
    // ConvexHttpClient is stateless HTTP — nothing to close
  }
}
