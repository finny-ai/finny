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

export const convexClient = lazy(() => {
  const url = process.env.CONVEX_URL || "https://brave-shark-548.convex.cloud"
  log.info("connecting to Convex", { url })
  return new ConvexHttpClient(url)
})

export namespace Database {
  export function close() {
    // ConvexHttpClient is stateless HTTP — nothing to close
  }
}
