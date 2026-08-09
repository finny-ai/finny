import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const QcCredentialInput = Schema.Struct({
  userId: Schema.String,
  apiToken: Schema.String,
})

export const QcStatusResponse = Schema.Struct({
  connected: Schema.Boolean,
  userId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const QcConnectResponse = Schema.Struct({
  connected: Schema.Literal(true),
  userId: Schema.String,
  name: Schema.String,
})

export const QcApi = HttpApi.make("qc").add(
  HttpApiGroup.make("qc")
    .add(
      HttpApiEndpoint.post("connect", "/qc/credentials", {
        payload: QcCredentialInput,
        success: QcConnectResponse,
        error: HttpApiError.BadRequest,
      }),
    )
    .add(
      HttpApiEndpoint.get("status", "/qc/status", {
        success: QcStatusResponse,
      }),
    )
    .add(
      HttpApiEndpoint.delete("disconnect", "/qc/credentials", {
        success: QcStatusResponse,
      }),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "QuantConnect",
        description: "Verify, store, and manage QuantConnect API credentials for the QC Cloud track.",
      }),
    ),
)
