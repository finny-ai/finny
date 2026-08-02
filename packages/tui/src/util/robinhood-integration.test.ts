import { expect, test } from "bun:test"
import {
  canRunRobinhoodLoginLocally,
  createRobinhoodIntegrationClient,
  managedRobinhoodLoginCommand,
  ROBINHOOD_INTEGRATION_PATH,
  type RobinhoodIntegrationStatus,
} from "./robinhood-integration"

test("Robinhood foreground login accepts trusted local Finny transports", () => {
  expect(canRunRobinhoodLoginLocally("http://opencode.internal")).toBe(true)
  expect(canRunRobinhoodLoginLocally("http://localhost:4096")).toBe(true)
  expect(canRunRobinhoodLoginLocally("http://127.0.0.1:4096")).toBe(true)
  expect(canRunRobinhoodLoginLocally("http://[::1]:4096")).toBe(true)
  expect(canRunRobinhoodLoginLocally("https://opencode.internal")).toBe(false)
  expect(canRunRobinhoodLoginLocally("http://opencode.internal:4096")).toBe(false)
  expect(canRunRobinhoodLoginLocally("https://finny.example.com")).toBe(false)
  expect(canRunRobinhoodLoginLocally("not a url")).toBe(false)
})

test("managed login launches the local pinned entrypoint cross-platform without a shell shim", () => {
  expect(
    managedRobinhoodLoginCommand({
      packageDirectory: "C:\\finny\\packages\\rhx\\node_modules\\rhx",
      profile: "work",
      runtimePath: "C:\\finny\\bun.exe",
      platform: "win32",
    }),
  ).toEqual({
    command: "C:\\finny\\bun.exe",
    args: ["C:\\finny\\packages\\rhx\\node_modules\\rhx\\bin\\rhx.cjs", "--profile", "work", "auth", "login"],
    entrypoint: "C:\\finny\\packages\\rhx\\node_modules\\rhx\\bin\\rhx.cjs",
  })
})

const ready: RobinhoodIntegrationStatus = {
  provider: "robinhood",
  package: "rhx",
  pinnedVersion: "0.4.8",
  status: "ready",
  supported: true,
  installed: true,
  ready: true,
  source: "managed",
  executablePath: "/tmp/rhx",
  profile: "default",
  loginArgs: ["--profile", "default", "auth", "login"],
  brokerage: { configured: true, ready: true, state: "ready" },
  crypto: { configured: false, ready: false, state: "not_configured" },
}

test("Robinhood integration client uses the global endpoint contract", async () => {
  const calls: { path: string; method: string; body?: unknown }[] = []
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return Response.json(ready)
  }) as typeof fetch
  const client = createRobinhoodIntegrationClient({ url: "http://localhost:4096", fetch: mockFetch })

  await client.status()
  await client.install({ executablePath: "/opt/rhx", profile: "work" })
  await client.verify({ profile: "work" })
  await client.disconnect()

  expect(calls).toEqual([
    { path: ROBINHOOD_INTEGRATION_PATH, method: "GET", body: undefined },
    {
      path: `${ROBINHOOD_INTEGRATION_PATH}/install`,
      method: "POST",
      body: { executablePath: "/opt/rhx", profile: "work" },
    },
    { path: `${ROBINHOOD_INTEGRATION_PATH}/verify`, method: "POST", body: { profile: "work" } },
    { path: ROBINHOOD_INTEGRATION_PATH, method: "DELETE", body: undefined },
  ])
})

test("Robinhood integration client normalizes nullable optional fields from Effect HttpApi", async () => {
  const wireStatus = {
    ...ready,
    source: null,
    executablePath: null,
    profile: null,
    loginArgs: null,
    message: null,
    checkedAt: null,
  }
  const client = createRobinhoodIntegrationClient({
    url: "http://localhost:4096",
    fetch: (async () => Response.json(wireStatus)) as unknown as typeof fetch,
  })

  expect(await client.status()).toEqual({
    provider: "robinhood",
    package: "rhx",
    pinnedVersion: "0.4.8",
    status: "ready",
    supported: true,
    installed: true,
    ready: true,
    brokerage: { configured: true, ready: true, state: "ready" },
    crypto: { configured: false, ready: false, state: "not_configured" },
  })
})

test("Robinhood integration client rejects malformed success payloads", async () => {
  const malformed = {
    ...ready,
    loginArgs: ["auth", { password: "must never be accepted" }],
    brokerage: { configured: "yes", ready: true, state: "ready" },
  }
  const client = createRobinhoodIntegrationClient({
    url: "http://localhost:4096",
    fetch: (async () => Response.json(malformed)) as unknown as typeof fetch,
  })

  await expect(client.status()).rejects.toThrow("Unexpected response from GET /global/integrations/robinhood")

  const malformedTimestamp = createRobinhoodIntegrationClient({
    url: "http://localhost:4096",
    fetch: (async () => Response.json({ ...ready, checkedAt: 123 })) as unknown as typeof fetch,
  })
  await expect(malformedTimestamp.status()).rejects.toThrow(
    "Unexpected response from GET /global/integrations/robinhood",
  )
})

test("Robinhood integration client surfaces backend error messages", async () => {
  const client = createRobinhoodIntegrationClient({
    url: "http://localhost:4096",
    fetch: (async () =>
      Response.json({ message: "manual executable must be absolute" }, { status: 400 })) as unknown as typeof fetch,
  })

  await expect(client.install({ executablePath: "rhx" })).rejects.toThrow("manual executable must be absolute")
})
