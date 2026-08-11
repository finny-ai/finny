import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const LeanStatusResponse = Schema.Struct({
  enabled: Schema.Boolean,
  effective: Schema.Boolean,
  adapterCert: Schema.optional(Schema.String),
  certified: Schema.Boolean,
  source: Schema.Literals(["env", "setting", "default"]),
  readiness: Schema.Struct({
    ready: Schema.Boolean,
    reasons: Schema.Array(Schema.String),
  }),
})

export const LeanEnabledRequest = Schema.Struct({
  enabled: Schema.Boolean,
})

export const LeanApi = HttpApi.make("lean").add(
  HttpApiGroup.make("lean")
    .add(
      HttpApiEndpoint.get("status", "/lean/status", {
        success: LeanStatusResponse,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lean.status",
          summary: "Read LEAN engine status",
          description: "Persisted setting, effective enablement, adapter certificate, and runtime readiness.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("setEnabled", "/lean/enabled", {
        payload: LeanEnabledRequest,
        success: LeanStatusResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lean.enabled",
          summary: "Enable or disable the LEAN engine",
          description: "Persists the setting; environment variables still win for test/harness runs.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "lean",
        description: "Native LEAN backtest engine configuration.",
      }),
    ),
)
