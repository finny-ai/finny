import { RobinhoodIntegration } from "@/integration/robinhood"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { IntegrationsHttpApi } from "../api"
import { RobinhoodIntegrationApiError } from "../groups/integrations"

const decodeOptionalInput = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const body = yield* request.text.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
  if (body.trim().length === 0) return {}
  const json = yield* Effect.try({
    try: () => JSON.parse(body),
    catch: () => new HttpApiError.BadRequest({}),
  })
  return yield* Schema.decodeUnknownEffect(RobinhoodIntegration.ConfigureInput)(json).pipe(
    Effect.mapError(() => new HttpApiError.BadRequest({})),
  )
})

function integrationResult(status: RobinhoodIntegration.Status) {
  if (status.status !== "error") return Effect.succeed(status)
  return Effect.fail(
    new RobinhoodIntegrationApiError({
      ...status,
      status: "error",
      message: status.message ?? "The rhx integration could not be checked.",
    }),
  )
}

export const integrationHandlers = HttpApiBuilder.group(IntegrationsHttpApi, "integrations", (handlers) =>
  Effect.gen(function* () {
    const integration = yield* RobinhoodIntegration.Service

    const status = Effect.fn("IntegrationsHttpApi.robinhoodStatus")(function* () {
      return yield* integrationResult(yield* integration.status())
    })

    const install = Effect.fn("IntegrationsHttpApi.robinhoodInstall")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const input = yield* decodeOptionalInput(ctx.request)
      const result = yield* integrationResult(yield* integration.install(input))
      return HttpServerResponse.jsonUnsafe(result)
    })

    const verify = Effect.fn("IntegrationsHttpApi.robinhoodVerify")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const input = yield* decodeOptionalInput(ctx.request)
      const result = yield* integrationResult(yield* integration.verify(input))
      return HttpServerResponse.jsonUnsafe(result)
    })

    const detach = Effect.fn("IntegrationsHttpApi.robinhoodDetach")(function* () {
      return yield* integrationResult(yield* integration.detach())
    })

    return handlers
      .handle("robinhoodStatus", status)
      .handleRaw("robinhoodInstall", install)
      .handleRaw("robinhoodVerify", verify)
      .handle("robinhoodDetach", detach)
  }),
)
