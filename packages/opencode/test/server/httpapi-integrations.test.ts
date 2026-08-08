import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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

const errorStatus: RobinhoodIntegration.Status = {
  ...status,
  status: "error",
  message: "The rhx integration could not be checked.",
}

const installInputs: RobinhoodIntegration.ConfigureInput[] = []
const verifyInputs: RobinhoodIntegration.ConfigureInput[] = []

const integration = RobinhoodIntegration.Service.of({
  status: () => Effect.succeed(status),
  install: (input) =>
    Effect.sync(() => {
      installInputs.push(input ?? {})
      return status
    }),
  verify: (input) =>
    Effect.sync(() => {
      verifyInputs.push(input ?? {})
      return status
    }),
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

const failingIntegration = RobinhoodIntegration.Service.of({
  ...integration,
  status: () => Effect.succeed(errorStatus),
  install: () => Effect.succeed(errorStatus),
  verify: () => Effect.succeed(errorStatus),
  detach: () => Effect.succeed(errorStatus),
})

function apiLayer(service: RobinhoodIntegration.Interface, password: Option.Option<string>) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(IntegrationsHttpApi).pipe(
      Layer.provide(integrationHandlers),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // The install and verify endpoints intentionally own raw body decoding.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(RobinhoodIntegration.Service, service)),
    Layer.provide(ServerAuth.Config.layer({ password, username: "opencode" })),
  )
}

const it = testEffect(apiLayer(integration, Option.none()))
const itFailing = testEffect(apiLayer(failingIntegration, Option.none()))
const itProtected = testEffect(apiLayer(integration, Option.some("secret")))

const executeDelete = (path: string) => HttpClientRequest.delete(path).pipe(HttpClient.execute)

describe("integrations HttpApi", () => {
  it.live("encodes the Robinhood status contract consumed by the TUI", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(IntegrationPaths.robinhood)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual(status)
    }),
  )

  it.live("decodes empty and valid install and verify payloads once", () =>
    Effect.gen(function* () {
      installInputs.length = 0
      verifyInputs.length = 0

      const emptyInstall = yield* HttpClient.post(IntegrationPaths.robinhoodInstall)
      const configuredVerify = yield* HttpClientRequest.post(IntegrationPaths.robinhoodVerify).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ executablePath: "/opt/rhx", profile: "work" })),
        HttpClient.execute,
      )

      expect(emptyInstall.status).toBe(200)
      expect(configuredVerify.status).toBe(200)
      expect(installInputs).toEqual([{}])
      expect(verifyInputs).toEqual([{ executablePath: "/opt/rhx", profile: "work" }])
    }),
  )

  it.live("rejects malformed JSON and invalid configuration payloads", () =>
    Effect.gen(function* () {
      const malformed = yield* HttpClientRequest.post(IntegrationPaths.robinhoodInstall).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )
      const invalid = yield* HttpClientRequest.post(IntegrationPaths.robinhoodVerify).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ profile: 42 })),
        HttpClient.execute,
      )

      expect(malformed.status).toBe(400)
      expect(invalid.status).toBe(400)
    }),
  )

  itFailing.live("uses the typed Robinhood status error for every integration operation", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all([
        HttpClient.get(IntegrationPaths.robinhood),
        HttpClient.post(IntegrationPaths.robinhoodInstall),
        HttpClient.post(IntegrationPaths.robinhoodVerify),
        executeDelete(IntegrationPaths.robinhood),
      ])

      for (const response of responses) {
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject(errorStatus)
      }
    }),
  )

  itProtected.live("requires configured basic authentication on every integration endpoint", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all([
        HttpClient.get(IntegrationPaths.robinhood),
        HttpClient.post(IntegrationPaths.robinhoodInstall),
        HttpClient.post(IntegrationPaths.robinhoodVerify),
        executeDelete(IntegrationPaths.robinhood),
      ])

      for (const response of responses) {
        expect(response.status).toBe(401)
        expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      }

      const authenticated = yield* HttpClientRequest.get(IntegrationPaths.robinhood).pipe(
        HttpClientRequest.setHeader("authorization", ServerAuth.header({ username: "opencode", password: "secret" })!),
        HttpClient.execute,
      )
      expect(authenticated.status).toBe(200)
    }),
  )
})
