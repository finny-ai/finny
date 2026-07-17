import { afterEach, describe, expect, test } from "bun:test"
import { ibkrSpec, listIbkrAccounts, readIbkrCredentials } from "../../src/live/brokers/ibkr"
import type { BrokerConnection, BrokerMode } from "../../src/live/brokers/types"

const ACCOUNT_ID = "DU1234567"
const CUSTOM_ENDPOINT = "127.0.0.1:7498"

afterEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
})

function envFor(input: {
  endpoint?: string
  mode?: BrokerMode
  connection?: BrokerConnection
  secret?: string
}) {
  return ibkrSpec.envVars({
    keyId: ACCOUNT_ID,
    secret: input.secret ?? "",
    endpoint: input.endpoint ?? "",
    mode: input.mode ?? "paper",
    connection: input.connection,
  })
}

function expectedEnv(input: {
  host?: string
  port: string
  mode?: BrokerMode
  connection?: BrokerConnection
  clientId?: string
}) {
  return {
    IBKR_ACCOUNT_ID: ACCOUNT_ID,
    IBKR_HOST: input.host ?? "127.0.0.1",
    IBKR_PORT: input.port,
    IBKR_MODE: input.mode ?? "paper",
    IBKR_CONNECTION_APP: input.connection ?? "tws",
    ...(input.clientId ? { IBKR_CLIENT_ID: input.clientId } : {}),
  }
}

function setStoredIbkrAccount(providerID: string, metadata: Record<string, string>) {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    [providerID]: {
      type: "api",
      key: "",
      metadata: { keyId: ACCOUNT_ID, ...metadata },
    },
  })
}

async function expectStoredAccount(
  providerID: string,
  expected: { endpoint: string; mode: BrokerMode; connection: BrokerConnection },
) {
  expect(await readIbkrCredentials(providerID)).toMatchObject({
    keyId: ACCOUNT_ID,
    ...expected,
  })
  expect(await listIbkrAccounts()).toEqual([
    expect.objectContaining({
      providerID,
      keyId: ACCOUNT_ID,
      ...expected,
    }),
  ])
}

describe("IBKR broker spec", () => {
  test("declares Gateway paper as the add-account default", () => {
    expect(ibkrSpec.defaultEndpoint).toBe("127.0.0.1:4002")
    expect(ibkrSpec.endpointForMode?.("paper")).toBe("127.0.0.1:4002")
    expect(ibkrSpec.credentialFields.find((field) => field.name === "connection")).toMatchObject({
      default: "gateway",
      choices: ["gateway", "tws"],
    })
    expect(ibkrSpec.credentialFields.find((field) => field.name === "secret")).toMatchObject({
      label: "Client ID (optional)",
      required: false,
    })
  })

  test("emits canonical endpoints for each connection and mode", () => {
    const cases: Array<{
      input: Parameters<typeof envFor>[0]
      expected: Parameters<typeof expectedEnv>[0]
    }> = [
      { input: { connection: "gateway", mode: "paper" }, expected: { connection: "gateway", port: "4002" } },
      { input: { connection: "gateway", mode: "live" }, expected: { connection: "gateway", mode: "live", port: "4001" } },
      { input: { connection: "tws", mode: "paper" }, expected: { connection: "tws", port: "7497" } },
      { input: { connection: "tws", mode: "live" }, expected: { connection: "tws", mode: "live", port: "7496" } },
      { input: { mode: "paper" }, expected: { connection: "tws", port: "7497" } },
    ]

    for (const c of cases) {
      expect(envFor(c.input)).toEqual(expectedEnv(c.expected))
    }
  })

  test("reads stored accounts with legacy and Gateway fallback endpoints", async () => {
    setStoredIbkrAccount("ibkr-legacy", { mode: "paper" })
    await expectStoredAccount("ibkr-legacy", {
      endpoint: "127.0.0.1:7497",
      mode: "paper",
      connection: "tws",
    })

    setStoredIbkrAccount("ibkr-gateway", { mode: "live", connection: "gateway" })
    await expectStoredAccount("ibkr-gateway", {
      endpoint: "127.0.0.1:4001",
      mode: "live",
      connection: "gateway",
    })
  })

  test("respects custom endpoints", () => {
    expect(envFor({ connection: "gateway", mode: "live", endpoint: "10.0.0.12:5000" })).toEqual(
      expectedEnv({ host: "10.0.0.12", port: "5000", mode: "live", connection: "gateway" }),
    )
  })

  test("uses the selected app default port when custom endpoint omits a port", () => {
    expect(envFor({ connection: "gateway", mode: "paper", endpoint: "10.0.0.12" })).toEqual(
      expectedEnv({ host: "10.0.0.12", port: "4002", connection: "gateway" }),
    )
  })

  test("includes IBKR_CLIENT_ID when secret is a valid integer", () => {
    expect(
      envFor({
        secret: " 777 ",
        endpoint: CUSTOM_ENDPOINT,
        mode: "paper",
      }),
    ).toEqual(expectedEnv({ port: "7498", clientId: "777" }))
  })

  test("omits IBKR_CLIENT_ID when secret is malformed", () => {
    for (const secret of ["abc", "101x", "101.5"]) {
      expect(envFor({ secret, endpoint: CUSTOM_ENDPOINT, mode: "paper" })).toEqual(expectedEnv({ port: "7498" }))
    }
  })
})
