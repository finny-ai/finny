import { RobinhoodIntegration } from "@/integration/robinhood"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { IntegrationsHttpApi } from "../api"

const decodeOptionalInput = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const body = yield* request.text.pipe(Effect.orDie)
  if (body.trim().length === 0) return {}
  const json = yield* Effect.try({
    try: () => JSON.parse(body),
    catch: () => new HttpApiError.BadRequest({}),
  })
  return yield* Schema.decodeUnknownEffect(RobinhoodIntegration.ConfigureInput)(json).pipe(
    Effect.mapError(() => new HttpApiError.BadRequest({})),
  )
})

function integrationResponse(status: RobinhoodIntegration.Status) {
  return HttpServerResponse.jsonUnsafe(status, { status: status.status === "error" ? 400 : 200 })
}

export const integrationHandlers = HttpApiBuilder.group(IntegrationsHttpApi, "integrations", (handlers) =>
  Effect.gen(function* () {
    const integration = yield* RobinhoodIntegration.Service

    const install = Effect.fn("IntegrationsHttpApi.robinhoodInstall")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const input = yield* decodeOptionalInput(ctx.request)
      return integrationResponse(yield* integration.install(input))
    })

    const verify = Effect.fn("IntegrationsHttpApi.robinhoodVerify")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const input = yield* decodeOptionalInput(ctx.request)
      return integrationResponse(yield* integration.verify(input))
    })

    return handlers
      .handle("robinhoodStatus", integration.status)
      .handleRaw("robinhoodInstall", install)
      .handleRaw("robinhoodVerify", verify)
      .handle("robinhoodDetach", integration.detach)
  }),
)
