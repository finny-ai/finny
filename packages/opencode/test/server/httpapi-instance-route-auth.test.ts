import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function app(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          OPENCODE_SERVER_PASSWORD: "secret",
        }),
      ),
    ),
  ),
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const servedRoutesWithNode = servedRoutes.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(servedRoutesWithNode)

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi instance route authorization", () => {
  it.live("leaves only minimal platform health probes unauthenticated", () =>
    Effect.gen(function* () {
      for (const [path, status] of [
        ["/livez", "live"],
        ["/readyz", "ready"],
      ] as const) {
        const response = yield* HttpClient.get(path)
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({
          status,
          version: expect.any(String),
        })
        expect(response.headers["cache-control"]).toBe("no-store")
      }

      const protectedHealth = yield* HttpClient.get("/global/health")
      expect(protectedHealth.status).toBe(401)
    }),
  )

  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("finny", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("finny", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})
