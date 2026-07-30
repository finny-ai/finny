import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { HealthApi } from "../groups/health"

function response(status: "live" | "ready") {
  return HttpServerResponse.jsonUnsafe(
    {
      status,
      version: InstallationVersion,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const healthHandlers = HttpApiBuilder.group(HealthApi, "health", (handlers) =>
  Effect.succeed(
    handlers
      .handleRaw("live", () => Effect.succeed(response("live")))
      .handleRaw("ready", () => Effect.succeed(response("ready"))),
  ),
)
