import { describe, expect, test } from "bun:test"
import {
  CONTROL_PROTOCOL_V1,
  AlgorithmId,
  AlgorithmSlug,
  ContentDigest,
  ControlApiCodecError,
  ControlApiFault,
  type ControlApiHandlers,
  ControlApiRemoteError,
  type ControlApiTransport,
  type GetAlgorithmResponse,
  type LifecycleGuardId,
  ResponseFrame,
  TenantId,
  UtcTimestamp,
  controlApiRpcBinding,
  createControlApiClient,
  createControlApiDispatcher,
  createInProcessTransport,
  operationDefinitions,
  strictDecode,
} from "../src"

const timestamp = "2026-08-08T20:00:00.000Z"
const contentDigest = `sha256:${"a".repeat(64)}`
const key = { tenantId: "local", algorithmId: "alg_01" } as const
const ref = { key, version: 1 } as const
const authenticatedContext = {
  tenantId: "local",
  actor: "user:local",
  scopes: ["algorithm:read"],
  requestId: "req_01",
} as const

function detail(): GetAlgorithmResponse {
  return {
    algorithm: {
      key,
      slug: "mean-reversion",
      displayName: "Mean Reversion",
      latestVersion: 1,
      updatedAt: timestamp,
    },
    version: {
      version: 1,
      state: "draft",
      contentDigest,
      createdAt: timestamp,
      mission: "Trade temporary dislocations.",
    },
  }
}

function handlers(overrides: Partial<ControlApiHandlers> = {}): ControlApiHandlers {
  const response = detail()
  return {
    "algorithm.list": () => ({ items: [response.algorithm] }),
    "algorithm.get": () => response,
    "algorithm.legal-next-actions": (request) => ({
      ref: request.ref,
      state: "draft",
      actions: [{ id: "validate", to: "validated", requiredEvidence: ["validation.passed"] }],
    }),
    ...overrides,
  }
}

function setup(overrides: Partial<ControlApiHandlers> = {}) {
  const dispatcher = createControlApiDispatcher({
    server: { name: "finny-controld", version: "0.1.0" },
    handlers: handlers(overrides),
  })
  const transport = createInProcessTransport({ dispatcher, context: authenticatedContext })
  return { dispatcher, transport, client: createControlApiClient(transport) }
}

describe("Control API wire contract", () => {
  test("performs a JSON-text byte roundtrip through the in-process transport", async () => {
    const server = setup().transport
    let requestBytes: Uint8Array | undefined
    let responseBytes: Uint8Array | undefined
    const observed: ControlApiTransport = {
      async roundTrip(requestJson) {
        requestBytes = new TextEncoder().encode(requestJson)
        const responseJson = await server.roundTrip(new TextDecoder().decode(requestBytes))
        responseBytes = new TextEncoder().encode(responseJson)
        return new TextDecoder().decode(responseBytes)
      },
    }
    const result = await createControlApiClient(observed).algorithms.get({ ref })

    expect(result.algorithm.displayName).toBe("Mean Reversion")
    expect(JSON.parse(new TextDecoder().decode(requestBytes))).toEqual({
      protocolVersion: CONTROL_PROTOCOL_V1,
      operation: "algorithm.get",
      request: { ref },
    })
    expect(JSON.parse(new TextDecoder().decode(responseBytes))).toMatchObject({
      protocolVersion: CONTROL_PROTOCOL_V1,
      operation: "algorithm.get",
      ok: true,
    })
  })

  test("confirms fixed V1 compatibility and then performs an authenticated call", async () => {
    const { client } = setup()
    await expect(client.handshake({ client: { name: "finny-cli", version: "0.1.0" } })).resolves.toEqual({
      server: { name: "finny-controld", version: "0.1.0" },
      protocolVersion: "1.0",
    })
    await expect(client.algorithms.get({ ref })).resolves.toMatchObject({ version: { version: 1 } })
  })

  test("rejects a non-V1 client with a structured compatibility error", async () => {
    const client = createControlApiClient(setup().transport, { protocolVersion: "2.0" })
    const caught = await client
      .handshake({ client: { name: "future-client", version: "2.0.0" } })
      .catch((error) => error)

    expect(caught).toBeInstanceOf(ControlApiRemoteError)
    expect(caught.detail).toMatchObject({
      code: "unsupported_protocol_version",
      supportedVersions: ["1.0"],
      requestedVersions: ["2.0"],
    })
  })

  test("rejects a non-V1 frame before decoding any operation payload", async () => {
    const responseJson = await setup().dispatcher.dispatch(
      JSON.stringify({ protocolVersion: "2.0", operation: "algorithm.get", request: { not: "v1" } }),
      authenticatedContext,
    )
    const response = strictDecode(ResponseFrame, JSON.parse(responseJson), "frame")

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe("unsupported_protocol_version")
  })

  test("matches kernel identity, slug, timestamp, version, and digest constraints", () => {
    expect(strictDecode(TenantId, "local", "request")).toBe("local")
    expect(strictDecode(TenantId, "x".repeat(255), "request")).toHaveLength(255)
    expect(() => strictDecode(TenantId, " local", "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(TenantId, `local\u0000`, "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(TenantId, "\ud800", "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(AlgorithmId, "x".repeat(256), "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(AlgorithmId, "\udfff", "request")).toThrow(ControlApiCodecError)
    expect(strictDecode(AlgorithmSlug, "mean-reversion.variant2", "request")).toBe("mean-reversion.variant2")
    expect(() => strictDecode(AlgorithmSlug, "x".repeat(129), "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(AlgorithmSlug, "mean_reversion", "request")).toThrow(ControlApiCodecError)
    expect(strictDecode(UtcTimestamp, "2024-02-29T23:59:59.123456Z", "request")).toBe("2024-02-29T23:59:59.123456Z")
    expect(() => strictDecode(UtcTimestamp, "2026-02-30T12:00:00Z", "request")).toThrow(ControlApiCodecError)
    expect(() => strictDecode(UtcTimestamp, "2026-08-08T20:00:00-04:00", "request")).toThrow(ControlApiCodecError)
    expect(strictDecode(ContentDigest, contentDigest, "request")).toBe(contentDigest)
    expect(() => strictDecode(ContentDigest, "a".repeat(64), "request")).toThrow(ControlApiCodecError)
  })

  test("exports one generic versioned JSON-RPC HTTP binding", () => {
    expect(controlApiRpcBinding).toMatchObject({
      protocolVersion: "1.0",
      method: "POST",
      path: "/control/v1/rpc",
    })
    for (const definition of Object.values(operationDefinitions)) {
      expect("path" in definition).toBe(false)
      expect("method" in definition).toBe(false)
    }
  })

  test("normalizes an invalid empty operation to a structured unknown frame", async () => {
    const responseJson = await setup().dispatcher.dispatch(
      JSON.stringify({ protocolVersion: "1.0", operation: "", request: {} }),
    )
    const response = strictDecode(ResponseFrame, JSON.parse(responseJson), "frame")

    expect(response.operation).toBe("unknown")
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error).toMatchObject({ code: "validation_error", phase: "frame" })
  })

  test("rejects excess and undefined request properties before transport", async () => {
    let calls = 0
    const client = createControlApiClient({
      async roundTrip() {
        calls++
        throw new Error("must not be called")
      },
    })

    await expect(client.algorithms.get({ ref, unknown: true } as never)).rejects.toBeInstanceOf(ControlApiCodecError)
    await expect(
      client.algorithms.get({ ref: { key: { ...key, algorithmId: undefined }, version: 1 } } as never),
    ).rejects.toBeInstanceOf(ControlApiCodecError)
    expect(calls).toBe(0)
  })

  test("rejects non-JSON request values and malformed response text", async () => {
    let calls = 0
    const client = createControlApiClient({
      async roundTrip() {
        calls++
        return "not-json"
      },
    })

    await expect(client.algorithms.get({ ref: { key, version: Number.NaN } } as never)).rejects.toBeInstanceOf(
      ControlApiCodecError,
    )
    expect(calls).toBe(0)
    await expect(client.algorithms.get({ ref })).rejects.toMatchObject({
      name: "ControlApiCodecError",
      phase: "frame",
    })
    expect(calls).toBe(1)
  })

  test("server validates manually supplied requests with the operation codec", async () => {
    const responseJson = await setup().dispatcher.dispatch(
      JSON.stringify({ protocolVersion: "1.0", operation: "algorithm.get", request: { ref: { ...ref, extra: true } } }),
      authenticatedContext,
    )
    const response = strictDecode(ResponseFrame, JSON.parse(responseJson), "frame")

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error).toMatchObject({ code: "validation_error", phase: "request" })
  })

  test("rejects cross-tenant, cross-key, and cross-version get projections", async () => {
    const invalid = [
      { ...detail(), algorithm: { ...detail().algorithm, key: { ...key, tenantId: "other" } } },
      { ...detail(), algorithm: { ...detail().algorithm, key: { ...key, algorithmId: "other" } } },
      { ...detail(), version: { ...detail().version, version: 2 } },
    ]

    for (const projected of invalid) {
      const { client } = setup({ "algorithm.get": (() => projected) as unknown as ControlApiHandlers["algorithm.get"] })
      const caught = await client.algorithms.get({ ref }).catch((error) => error)
      expect(caught).toBeInstanceOf(ControlApiRemoteError)
      expect(caught.detail).toMatchObject({ code: "validation_error", phase: "response" })
    }
  })

  test("client independently rejects a semantically inconsistent response", async () => {
    const projected = { ...detail(), version: { ...detail().version, version: 2 } }
    const client = createControlApiClient({
      roundTrip: async () =>
        JSON.stringify({
          protocolVersion: "1.0",
          operation: "algorithm.get",
          ok: true,
          response: projected,
        }),
    })

    await expect(client.algorithms.get({ ref })).rejects.toMatchObject({
      name: "ControlApiCodecError",
      phase: "response",
      operation: "algorithm.get",
    })
  })

  test("rejects a latest-version projection older than the requested exact version", async () => {
    const requested = { key, version: 2 } as const
    const projected = {
      ...detail(),
      algorithm: { ...detail().algorithm, latestVersion: 1 },
      version: { ...detail().version, version: 2 },
    }
    const { client } = setup({
      "algorithm.get": (() => projected) as unknown as ControlApiHandlers["algorithm.get"],
    })
    const caught = await client.algorithms.get({ ref: requested }).catch((error) => error)

    expect(caught).toBeInstanceOf(ControlApiRemoteError)
    expect(caught.detail).toMatchObject({ code: "validation_error", phase: "response" })
  })

  test("rejects an illegal legal-next-action projection", async () => {
    const { client } = setup({
      "algorithm.legal-next-actions": (request) => ({
        ref: request.ref,
        state: "draft",
        actions: [{ id: "start_live", to: "live_running", requiredEvidence: ["live.gate_passed"] }],
      }),
    })
    const caught = await client.algorithms.legalNextActions({ ref }).catch((error) => error)

    expect(caught).toBeInstanceOf(ControlApiRemoteError)
    expect(caught.detail).toMatchObject({ code: "validation_error", phase: "response" })
  })

  test("requires the exact ordered lifecycle guard tuple", async () => {
    const exact: readonly LifecycleGuardId[] = [
      "paper.minimum_ledger_duration_met",
      "paper.drift_within_bounds",
      "runtime.pinned_image_attested",
    ]
    const valid = setup({
      "algorithm.legal-next-actions": (request) => ({
        ref: request.ref,
        state: "paper_running",
        actions: [{ id: "establish_live_eligibility", to: "live_eligible", requiredEvidence: exact }],
      }),
    })
    await expect(valid.client.algorithms.legalNextActions({ ref })).resolves.toMatchObject({
      actions: [{ requiredEvidence: exact }],
    })

    const invalid: readonly (readonly LifecycleGuardId[])[] = [
      exact.slice(0, 2),
      [...exact, "deployment.stopped"],
      [exact[0], exact[1], exact[1], exact[2]],
      [exact[0], "live.gate_passed", exact[2]],
      [exact[1], exact[0], exact[2]],
    ]
    for (const requiredEvidence of invalid) {
      const { client } = setup({
        "algorithm.legal-next-actions": (request) => ({
          ref: request.ref,
          state: "paper_running",
          actions: [{ id: "establish_live_eligibility", to: "live_eligible", requiredEvidence: [...requiredEvidence] }],
        }),
      })
      const caught = await client.algorithms.legalNextActions({ ref }).catch((error) => error)
      expect(caught).toBeInstanceOf(ControlApiRemoteError)
      expect(caught.detail).toMatchObject({ code: "validation_error", phase: "response" })
    }
  })

  test("blocks cross-tenant IDOR before invoking a handler", async () => {
    let calls = 0
    const dispatcher = createControlApiDispatcher({
      server: { name: "finny-controld", version: "0.1.0" },
      handlers: handlers({
        "algorithm.get": () => {
          calls++
          return detail()
        },
      }),
    })
    const transport = createInProcessTransport({
      dispatcher,
      context: { ...authenticatedContext, tenantId: "other" },
    })
    const caught = await createControlApiClient(transport)
      .algorithms.get({ ref })
      .catch((error) => error)

    expect(calls).toBe(0)
    expect(caught).toBeInstanceOf(ControlApiRemoteError)
    expect(caught.detail).toMatchObject({ code: "forbidden" })
  })

  test("enforces declarative read scope before invoking a handler", async () => {
    let calls = 0
    const dispatcher = createControlApiDispatcher({
      server: { name: "finny-controld", version: "0.1.0" },
      handlers: handlers({
        "algorithm.get": () => {
          calls++
          return detail()
        },
      }),
    })
    const transport = createInProcessTransport({
      dispatcher,
      context: { ...authenticatedContext, scopes: [] },
    })
    const caught = await createControlApiClient(transport)
      .algorithms.get({ ref })
      .catch((error) => error)

    expect(calls).toBe(0)
    expect(caught.detail).toMatchObject({ code: "forbidden", requiredScopes: ["algorithm:read"] })
  })

  test("passes typed authenticated context to handlers", async () => {
    let observedRequestId: string | undefined
    const { client } = setup({
      "algorithm.get": (_request, context) => {
        observedRequestId = context.requestId
        return detail()
      },
    })

    await client.algorithms.get({ ref })
    expect(observedRequestId).toBe("req_01")
  })

  test("maps explicit handler faults without exposing handler exceptions", async () => {
    const { client } = setup({
      "algorithm.get": () => {
        throw new ControlApiFault({
          code: "resource_not_found",
          message: "Algorithm version was not found",
          resource: "algorithm-version",
        })
      },
    })
    const caught = await client.algorithms.get({ ref }).catch((error) => error)

    expect(caught).toBeInstanceOf(ControlApiRemoteError)
    expect(caught.detail).toMatchObject({ code: "resource_not_found" })
  })

  test("does not leak request or response mutations through shared references", async () => {
    const handlerOwned = detail()
    const request = { ref: { key: { ...key }, version: 1 } }
    const { client } = setup({
      "algorithm.get": (serverRequest) => {
        ;(serverRequest.ref.key as { algorithmId: string }).algorithmId = "mutated-on-server"
        ;(serverRequest.ref.key as { algorithmId: string }).algorithmId = "alg_01"
        return handlerOwned
      },
    })
    const response = await client.algorithms.get(request)

    expect(request.ref.key.algorithmId).toBe("alg_01")
    ;(response.algorithm as { displayName: string }).displayName = "mutated-on-client"
    expect(handlerOwned.algorithm.displayName).toBe("Mean Reversion")
  })
})
