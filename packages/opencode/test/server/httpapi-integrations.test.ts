import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RobinhoodIntegration } from "@/integration/robinhood"
import { ServerAuth } from "@/server/auth"
import { IntegrationsHttpApi } from "@/server/routes/instance/httpapi/api"
import { IntegrationPaths } from "@/server/routes/instance/httpapi/groups/integrations"
import { integrationHandlers } from "@/server/routes/instance/httpapi/handlers/integrations"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const status: RobinhoodIntegration.Status = {
  provider: "robinhood",
  package: "rhx",
  pinnedVersion: "0.4.8",
  status: "not_installed",
  supported: true,
  installed: false,
  ready: false,
  brokerage: { configured: false, ready: false, state: "unknown" },
  crypto: { configured: false, ready: false, state: "unknown" },
  message: "Install rhx or attach an absolute path to an existing executable.",
}

const integration = RobinhoodIntegration.Service.of({
  status: () => Effect.succeed(status),
  install: () => Effect.succeed(status),
  verify: () => Effect.succeed(status),
  detach: () => Effect.succeed(status),
  promptContext: () =>
    Effect.succeed({
      provider: "robinhood",
      status: "not_installed",
      ready: false,
      pinnedVersion: "0.4.8",
      capabilities: [],
    }),
})

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(IntegrationsHttpApi).pipe(
    Layer.provide(integrationHandlers),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.succeed(RobinhoodIntegration.Service, integration)),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("integrations HttpApi", () => {
  it.live("encodes the Robinhood status contract consumed by the TUI", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(IntegrationPaths.robinhood)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual(status)
    }),
  )
})
