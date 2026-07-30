import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const HealthPaths = {
  live: "/livez",
  ready: "/readyz",
} as const

export const HealthResponse = Schema.Struct({
  status: Schema.Literals(["live", "ready"]),
  version: Schema.String,
})

export const HealthApi = HttpApi.make("health").add(
  HttpApiGroup.make("health")
    .add(
      HttpApiEndpoint.get("live", HealthPaths.live, {
        success: HealthResponse,
      }),
    )
    .add(
      HttpApiEndpoint.get("ready", HealthPaths.ready, {
        success: HealthResponse,
      }),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "health",
        description: "Unauthenticated process probes for private platform health checks.",
      }),
    ),
)
