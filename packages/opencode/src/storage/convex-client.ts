import { ConvexHttpClient } from "convex/browser"
import { NamedError } from "../util/error"
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

// Production deployment of the finny-merge Convex project. Used by email
// subscription (and any caller that wants a guaranteed target) when
// CONVEX_URL is unset. The shared client stays no-op without CONVEX_URL so
// tests and offline runs never hit production by accident.
export const DEFAULT_CONVEX_URL = "https://wry-mastiff-821.convex.cloud"

export const convexClient = lazy(() => {
  const url = process.env.CONVEX_URL
  if (!url) {
    log.info("CONVEX_URL not set, Convex client disabled (no-op)")
    return noopConvexClient()
  }
  log.info("connecting to Convex", { url })
  return new ConvexHttpClient(url)
})

// Prefer CONVEX_URL; fall back to production so consumer features like email
// capture work out of the box. Pass CONVEX_URL="" to force the no-op client.
export const convexClientOrDefault = lazy(() => {
  const env = process.env.CONVEX_URL
  if (env === "") {
    log.info("CONVEX_URL empty, Convex client disabled (no-op)")
    return noopConvexClient()
  }
  const url = env || DEFAULT_CONVEX_URL
  log.info("connecting to Convex (defaulted)", { url })
  return new ConvexHttpClient(url)
})

function noopConvexClient(): ConvexHttpClient {
  const noop = async () => null
  return new Proxy({} as ConvexHttpClient, {
    get: (_target, prop) => {
      // Don't be accidentally thenable: returning a function for `then`
      // would make `await convexClient()` hang, since the would-be
      // then(resolve, reject) callback would never call resolve.
      if (prop === "then" || typeof prop === "symbol") return undefined
      return noop
    },
  })
}

export namespace Database {
  export function close() {
    // ConvexHttpClient is stateless HTTP — nothing to close
  }
}
