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
  engineImage: Schema.Struct({
    pinnedCommit: Schema.String,
    pinnedDigest: Schema.String,
    daemonUp: Schema.Boolean,
    imagePresent: Schema.Boolean,
    imageRef: Schema.String,
  }),
})

export const LeanEnabledRequest = Schema.Struct({
  enabled: Schema.Boolean,
})

export const LeanEngineActionResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  pinnedCommit: Schema.String,
  pinnedDigest: Schema.String,
  daemonUp: Schema.Boolean,
  imagePresent: Schema.Boolean,
  imageRef: Schema.String,
  localDigest: Schema.optional(Schema.String),
  requiresRestart: Schema.optional(Schema.Boolean),
  newCommit: Schema.optional(Schema.String),
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
      HttpApiEndpoint.post("pullEngineImage", "/lean/engine/pull", {
        success: LeanEngineActionResult,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lean.engine.pull",
          summary: "Pull the pinned LEAN engine image",
          description: "Pulls the certified image for the pinned commit and verifies its digest.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("buildEngineImage", "/lean/engine/build", {
        success: LeanEngineActionResult,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lean.engine.build",
          summary: "Build the LEAN engine image from the bundled template",
          description: "Builds the Dockerfile template at the pinned commit; publishing still requires the release pipeline.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("updateEngineImage", "/lean/engine/update", {
        success: LeanEngineActionResult,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "lean.engine.update",
          summary: "Update the LEAN engine to the latest upstream commit",
          description: "Checks QuantConnect Lean master; when newer, rebuilds the pinned image and updates constants (repo checkout required).",
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
