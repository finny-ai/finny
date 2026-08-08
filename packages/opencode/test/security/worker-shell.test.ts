import { describe, expect, test } from "bun:test"
import {
  assertNoWorkerEnvironmentEnumeration,
  DATA_PROVIDER_CREDENTIALS,
  MODEL_CHILD_SECRET_ENV_KEYS,
  WORKER_SHELL_POLICY_VERSION,
  dataCredentialKeysForAsset,
  listWorkerDataCredentialKeys,
  listWorkerRuntimeKeys,
  redactSensitiveOutput,
  stripModelChildSecrets,
  workerRuntimeEnv,
  workerShellEnv,
} from "../../src/security/worker-shell"
import {
  TELEMETRY_PAYLOAD_ENV,
  aiSdkTelemetryPrivacy,
  sanitizeTelemetryPayload,
  telemetryCapturePolicy,
} from "../../src/security/telemetry"

const workers = ["data_extractor", "news_agent", "researcher", "research", "sec_agent", "sentiment_agent"]

describe("worker shell environment policy", () => {
  test("exports a versioned deny-by-default inventory", () => {
    expect(WORKER_SHELL_POLICY_VERSION).toBe(1)
    expect(listWorkerRuntimeKeys()).toContain("PATH")
    expect(listWorkerRuntimeKeys()).toContain("FINNY_HARNESS_MARKET_DATA_URL")
    expect(listWorkerRuntimeKeys()).not.toContain("OPENAI_API_KEY")
    expect(listWorkerRuntimeKeys()).not.toContain("FINNY_TELEMETRY_SECRET")
    expect(listWorkerDataCredentialKeys()).toContain("ALPACA_API_KEY_ID")
    expect(listWorkerDataCredentialKeys()).toContain("ALPACA_OAUTH_TOKEN")
    expect(listWorkerDataCredentialKeys()).toContain("ALPACA_DATA_FEED")
    expect(listWorkerDataCredentialKeys()).toContain("BINANCE_BASE_URL")
    expect(listWorkerDataCredentialKeys()).toContain("KITE_ACCESS_TOKEN")
    expect(listWorkerDataCredentialKeys()).toContain("SAXO_ACCESS_TOKEN")
    expect(listWorkerDataCredentialKeys()).toContain("QUESTRADE_ACCESS_TOKEN")
    expect(listWorkerDataCredentialKeys()).toContain("FUTU_HOST")
    // Trading secrets and LLM keys must never appear in the data registry.
    expect(listWorkerDataCredentialKeys()).not.toContain("BINANCE_API_KEY")
    expect(listWorkerDataCredentialKeys()).not.toContain("OPENAI_API_KEY")
    expect(DATA_PROVIDER_CREDENTIALS.length).toBeGreaterThan(0)
  })

  test("runtime-only environments exclude all host secrets and RHX live tokens", () => {
    expect(
      workerRuntimeEnv({
        PATH: "/safe/bin",
        HOME: "/safe/home",
        FINNY_ROBINHOOD_MCP_URL: "http://127.0.0.1:7777/private",
        FINNY_SERVER_PASSWORD: "finny-password",
        OPENCODE_SERVER_PASSWORD: "opencode-password",
        RHX_LIVE_CONFIRM_TOKEN: "must-not-leak",
        RH_CRYPTO_PRIVATE_KEY_B64: "must-not-leak-either",
      }),
    ).toEqual({ PATH: "/safe/bin", HOME: "/safe/home" })
  })

  test("scrubs runner broker and server credentials from every model child", () => {
    const host = {
      PATH: "/safe/bin",
      FINNY_ROBINHOOD_MCP_URL: "http://127.0.0.1:7777/private",
      FINNY_SERVER_PASSWORD: "finny-password",
      OPENCODE_SERVER_PASSWORD: "opencode-password",
      BENIGN_PRIMARY_VALUE: "kept-for-primary-agent",
    }

    expect(MODEL_CHILD_SECRET_ENV_KEYS).toEqual([
      "FINNY_ROBINHOOD_MCP_URL",
      "FINNY_SERVER_PASSWORD",
      "OPENCODE_SERVER_PASSWORD",
    ])
    expect(stripModelChildSecrets({ ...host, finny_server_password: "case-variant" })).toEqual({
      PATH: "/safe/bin",
      BENIGN_PRIMARY_VALUE: "kept-for-primary-agent",
    })

    const primary = workerShellEnv({ agent: "build", env: host })
    expect(primary.PATH).toBe("/safe/bin")
    expect(primary.BENIGN_PRIMARY_VALUE).toBe("kept-for-primary-agent")
    for (const key of MODEL_CHILD_SECRET_ENV_KEYS) expect(primary[key]).toBeUndefined()

    for (const agent of workers) {
      const worker = workerShellEnv({ agent, env: host })
      expect(worker.PATH).toBe("/safe/bin")
      for (const key of MODEL_CHILD_SECRET_ENV_KEYS) expect(worker[key]).toBeUndefined()
    }
  })

  test("every Finny worker filters host and plugin secrets", () => {
    for (const agent of workers) {
      const result = workerShellEnv({
        agent,
        env: {
          PATH: "/safe/bin",
          HOME: "/safe/home",
          OPENAI_API_KEY: "host-canary-secret",
          ANTHROPIC_API_KEY: "anthropic-canary",
          PLUGIN_INJECTED_SECRET: "plugin-canary-secret",
          FINNY_TELEMETRY_SECRET: "telemetry-canary-secret",
          FINNY_ROBINHOOD_MCP_URL: "http://127.0.0.1:7777/private",
          FINNY_SERVER_PASSWORD: "finny-password",
          OPENCODE_SERVER_PASSWORD: "opencode-password",
          FINNY_HARNESS_MARKET_DATA_URL: "http://127.0.0.1:9/fixture",
          FINNY_HARNESS_MODE: "1",
        },
      })
      expect(result.PATH).toBe("/safe/bin")
      expect(result.HOME).toBe("/safe/home")
      expect(result.OPENAI_API_KEY).toBeUndefined()
      expect(result.ANTHROPIC_API_KEY).toBeUndefined()
      expect(result.PLUGIN_INJECTED_SECRET).toBeUndefined()
      expect(result.FINNY_TELEMETRY_SECRET).toBeUndefined()
      expect(result.FINNY_ROBINHOOD_MCP_URL).toBeUndefined()
      expect(result.FINNY_SERVER_PASSWORD).toBeUndefined()
      expect(result.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      // Non-secret harness fixture plumbing must remain available (Data Agent curl).
      expect(result.FINNY_HARNESS_MARKET_DATA_URL).toBe("http://127.0.0.1:9/fixture")
      expect(result.FINNY_HARNESS_MODE).toBe("1")
    }
  })

  test("Data Agent receives only asset-relevant provider credentials", () => {
    const env = {
      ALPACA_OAUTH_TOKEN: "alpaca-bearer",
      ALPACA_API_KEY_ID: "alpaca-id",
      ALPACA_API_SECRET_KEY: "alpaca-secret",
      ALPACA_DATA_FEED: "iex",
      POLYGON_API_KEY: "polygon-secret",
      BINANCE_API_KEY: "binance-secret",
      BINANCE_BASE_URL: "https://data-api.binance.vision",
      KITE_API_KEY: "kite-id",
      KITE_ACCESS_TOKEN: "kite-secret",
    }
    const equity = workerShellEnv({
      agent: "data_extractor",
      env,
      request: { requested_asset_class: "equity", requested_symbol: "RELIANCE.NS" },
    })
    expect(equity).toMatchObject({
      ALPACA_OAUTH_TOKEN: "alpaca-bearer",
      ALPACA_API_KEY_ID: "alpaca-id",
      ALPACA_API_SECRET_KEY: "alpaca-secret",
      ALPACA_DATA_FEED: "iex",
      POLYGON_API_KEY: "polygon-secret",
      BINANCE_BASE_URL: "https://data-api.binance.vision",
      KITE_API_KEY: "kite-id",
      KITE_ACCESS_TOKEN: "kite-secret",
    })
    expect(equity.BINANCE_API_KEY).toBeUndefined()
    expect(equity.KITE_API_KEY).toBe("kite-id")
    expect(equity.KITE_ACCESS_TOKEN).toBe("kite-secret")
    expect(dataCredentialKeysForAsset("equity").has("ALPACA_DATA_FEED")).toBe(true)

    const canada = workerShellEnv({
      agent: "data_extractor",
      env,
      request: { requested_asset_class: "equity", requested_symbol: "SHOP.TO" },
    })
    expect(canada.KITE_API_KEY).toBeUndefined()
    expect(canada.KITE_ACCESS_TOKEN).toBeUndefined()

    const crypto = workerShellEnv({ agent: "data_extractor", env, request: { requested_asset_class: "crypto" } })
    expect(crypto.BINANCE_BASE_URL).toBe("https://data-api.binance.vision")
    expect(crypto.ALPACA_API_KEY_ID).toBeUndefined()
    expect(crypto.ALPACA_OAUTH_TOKEN).toBeUndefined()
    expect(crypto.ALPACA_API_SECRET_KEY).toBeUndefined()
    expect(crypto.ALPACA_DATA_FEED).toBeUndefined()
    expect(crypto.POLYGON_API_KEY).toBeUndefined()
    expect(crypto.BINANCE_API_KEY).toBeUndefined()
    expect(crypto.KITE_ACCESS_TOKEN).toBeUndefined()
  })

  test("unknown asset class does not unlock equity credentials", () => {
    const env = {
      ALPACA_API_KEY_ID: "alpaca-id",
      POLYGON_API_KEY: "polygon-secret",
      BINANCE_BASE_URL: "https://data-api.binance.vision",
    }
    const unknown = workerShellEnv({
      agent: "data_extractor",
      env,
      request: { requested_asset_class: "mystery" },
    })
    expect(unknown.ALPACA_API_KEY_ID).toBeUndefined()
    expect(unknown.POLYGON_API_KEY).toBeUndefined()
    expect(unknown.BINANCE_BASE_URL).toBe("https://data-api.binance.vision")
  })

  test("blocks direct, builtin, interpreter, substitution, and child-process enumeration", () => {
    const attacks = [
      "env",
      "printenv",
      "set",
      "export -p",
      "echo $(env)",
      "compgen -e",
      "python -c 'import os; print(os.environ)'",
      "python -c 'import os; print(dict(os.environ))'",
      "node -e 'console.log(process.env)'",
      "node -e 'console.log(JSON.stringify(process.env))'",
      "ruby -e 'puts ENV.to_h'",
      "python -c 'import subprocess; print(subprocess.check_output([\"env\"]))'",
      'node -e \'require("child_process").execSync("printenv")\'',
    ]
    for (const command of attacks) {
      expect(() => assertNoWorkerEnvironmentEnumeration({ agent: "data_extractor", command })).toThrow(
        "may not enumerate the process environment",
      )
    }
  })

  test("allows scoped provider lookup while non-allowlisted interpolation has no value", () => {
    expect(() =>
      assertNoWorkerEnvironmentEnumeration({
        agent: "data_extractor",
        command: "python -c 'import os; print(os.environ.get(\"ALPACA_API_KEY_ID\") is not None)'",
      }),
    ).not.toThrow()
    const env = workerShellEnv({
      agent: "data_extractor",
      env: { ALPACA_API_KEY_ID: "allowed-id", HOST_SECRET: "must-not-appear" },
      request: { requested_asset_class: "equity" },
    })
    expect(env.ALPACA_API_KEY_ID).toBe("allowed-id")
    expect(env.HOST_SECRET).toBeUndefined()
  })

  test("redacts scoped credential values and secret-shaped assignments before persistence", () => {
    const output = redactSensitiveOutput({
      text: "ALPACA_API_SECRET_KEY=provider-canary\nALPACA_OAUTH_TOKEN=oauth-canary\nOPENAI_API_KEY=unknown-canary\nsk-1234567890abcdefghijklmnop",
      env: { ALPACA_API_SECRET_KEY: "provider-canary", ALPACA_OAUTH_TOKEN: "oauth-canary" },
    })
    expect(output).not.toContain("provider-canary")
    expect(output).not.toContain("unknown-canary")
    expect(output).not.toContain("sk-1234567890abcdefghijklmnop")
    expect(output).not.toContain("oauth-canary")
    expect(output.match(/\[REDACTED\]/g)?.length).toBe(4)
  })
})

test("AI SDK telemetry omits prompt and completion payloads", () => {
  expect(aiSdkTelemetryPrivacy).toEqual({ recordInputs: false, recordOutputs: false })
  expect(TELEMETRY_PAYLOAD_ENV.enable).toBe("FINNY_OTEL_CAPTURE_PAYLOADS")
  expect(TELEMETRY_PAYLOAD_ENV.retentionHours).toBe("FINNY_OTEL_PAYLOAD_RETENTION_HOURS")
  expect(TELEMETRY_PAYLOAD_ENV.maxBytes).toBe("FINNY_OTEL_PAYLOAD_MAX_BYTES")
})

describe("opt-in telemetry payload sanitizer", () => {
  test("defaults to metadata-only capture", () => {
    const result = sanitizeTelemetryPayload("do not capture", { enabled: false })
    expect(result.content).toBeUndefined()
    expect(result.capturedBytes).toBe(0)
    expect(result.sha256).toHaveLength(64)
  })

  test("requires explicit opt-in and a bounded retention window", () => {
    expect(telemetryCapturePolicy({})).toEqual({ enabled: false })
    expect(
      telemetryCapturePolicy({
        [TELEMETRY_PAYLOAD_ENV.enable]: "1",
        [TELEMETRY_PAYLOAD_ENV.retentionHours]: "0",
      }),
    ).toEqual({ enabled: false })
    expect(
      telemetryCapturePolicy({
        [TELEMETRY_PAYLOAD_ENV.enable]: "1",
        [TELEMETRY_PAYLOAD_ENV.retentionHours]: "25",
      }),
    ).toEqual({ enabled: false })
    expect(
      telemetryCapturePolicy({
        [TELEMETRY_PAYLOAD_ENV.enable]: "1",
        [TELEMETRY_PAYLOAD_ENV.retentionHours]: "12",
        [TELEMETRY_PAYLOAD_ENV.maxBytes]: "999999",
      }),
    ).toEqual({ enabled: true, retentionHours: 12, maxBytes: 32 * 1024 })
  })

  test("redacts recursively and applies a deterministic UTF-8 byte bound", () => {
    const policy = { enabled: true, retentionHours: 6, maxBytes: 120 } as const
    const payload = {
      prompt: "provider=known-canary " + "é".repeat(100),
      nested: { apiKey: "unknown-canary", message: "OPENAI_API_KEY=literal-canary" },
    }
    const first = sanitizeTelemetryPayload(payload, policy, { PROVIDER_SECRET: "known-canary" })
    const second = sanitizeTelemetryPayload(payload, policy, { PROVIDER_SECRET: "known-canary" })
    expect(first).toEqual(second)
    expect(first.content).not.toContain("known-canary")
    expect(first.content).not.toContain("unknown-canary")
    expect(first.content).not.toContain("literal-canary")
    expect(first.capturedBytes).toBeLessThanOrEqual(120)
    expect(first.truncated).toBe(true)
    expect(first.retentionHours).toBe(6)
  })
})
