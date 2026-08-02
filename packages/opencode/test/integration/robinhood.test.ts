import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import { RobinhoodIntegration } from "@/integration/robinhood"
import { IntegrationPaths } from "@/server/routes/instance/httpapi/groups/integrations"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer, Option, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { tmpdir } from "../fixture/fixture"

type ProcessOutput = { code?: number; stdout?: unknown; stderr?: unknown; schema?: string }

function envelope(command: string, data: unknown, schema = "v4") {
  return {
    ok: true,
    command,
    provider: null,
    data,
    error: null,
    meta: { output_schema: schema, timestamp: "2026-08-01T00:00:00Z", view: "summary" },
  }
}

function doctorData(input?: { brokerage?: boolean; crypto?: boolean }) {
  return {
    auth: {
      brokerage: {
        session_file_exists: input?.brokerage ?? false,
        credentials_present: input?.brokerage ?? false,
        session_ready: input?.brokerage ?? false,
        detail: "fixture detail",
      },
      crypto: {
        provider: "crypto",
        authenticated: input?.crypto ?? false,
        mfa_required: false,
        state: input?.crypto ? "READY" : "CREDENTIALS_MISSING",
        detail: "fixture detail",
      },
    },
    // The service must never pass through paths or other doctor details.
    session_file: "/secret/session.json",
  }
}

function authStatus(state: string, input?: { authenticated?: boolean; mfa?: boolean; detail?: string }) {
  return {
    provider: "brokerage",
    authenticated: input?.authenticated ?? state === "READY",
    mfa_required: input?.mfa ?? state === "MFA_REQUIRED_DO_NOT_RETRY",
    state,
    detail: input?.detail ?? "fixture detail",
  }
}

function makeNpmLayer(executablePath: string, npmCalls: string[]) {
  return Layer.succeed(
    Npm.Service,
    Npm.Service.of({
      add: (spec) => {
        npmCalls.push(`add:${spec}`)
        return Effect.succeed({ directory: path.dirname(executablePath), entrypoint: Option.none() })
      },
      install: () => Effect.void,
      which: (spec, bin) => {
        npmCalls.push(`which:${spec}:${bin ?? ""}`)
        return Effect.succeed(Option.some(executablePath))
      },
    }),
  )
}

function serializedOutput(value: unknown) {
  return value === undefined ? "" : JSON.stringify(value)
}

function commandText(command?: string, args: readonly string[] = []) {
  return [command, ...args].filter(Boolean).join(" ")
}

function makeProcessLayer(process: (command: string, args: readonly string[], env: unknown) => ProcessOutput) {
  return Layer.mock(AppProcess.Service)({
    run: (command) => {
      const standard = ChildProcess.isStandardCommand(command) ? command : undefined
      const result = process(standard?.command ?? "", standard?.args ?? [], standard?.options.env)
      return Effect.succeed({
        command: commandText(standard?.command, standard?.args),
        exitCode: result.code ?? 0,
        stdout: Buffer.from(serializedOutput(result.stdout)),
        stderr: Buffer.from(serializedOutput(result.stderr)),
        stdoutTruncated: false,
        stderrTruncated: false,
      })
    },
    runStream: () => Stream.empty,
  })
}

function makeAuthLayer(auth: Record<string, Auth.Info>) {
  return Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      all: () => Effect.succeed({ ...auth }),
      get: (id) => Effect.succeed(auth[id]),
      set: (id, value) => Effect.sync(() => void (auth[id] = value)),
      remove: (id) => Effect.sync(() => void delete auth[id]),
    }),
  )
}

async function fixture(input: {
  platform?: string
  arch?: string
  executablePath: string
  process: (command: string, args: readonly string[], env: unknown) => ProcessOutput
  run: (service: RobinhoodIntegration.Interface, auth: Record<string, Auth.Info>) => Effect.Effect<void>
}) {
  await using tmp = await tmpdir()
  const npmCalls: string[] = []
  const auth: Record<string, Auth.Info> = {}

  const state = path.join(tmp.path, "state")
  const layer = RobinhoodIntegration.layerWith({ platform: input.platform, arch: input.arch }).pipe(
    Layer.provide(makeNpmLayer(input.executablePath, npmCalls)),
    Layer.provide(makeProcessLayer(input.process)),
    Layer.provide(makeAuthLayer(auth)),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ state })),
  )

  await Effect.gen(function* () {
    const service = yield* RobinhoodIntegration.Service
    yield* input.run(service, auth)
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

  const stateFile = Bun.file(path.join(state, "integrations", "robinhood.json"))
  const persistedState = (await stateFile.exists()) ? await stateFile.text() : undefined
  return { npmCalls, persistedState }
}

type VerificationScenario = "mfa" | "expired" | "crypto" | "ready"

const brokerageStatus: Record<VerificationScenario, () => ReturnType<typeof authStatus>> = {
  mfa: () => authStatus("MFA_REQUIRED_DO_NOT_RETRY", { mfa: true, detail: "approval for alice@example.com" }),
  expired: () => authStatus("SESSION_EXPIRED", { detail: "token secret-token expired" }),
  crypto: () => authStatus("CREDENTIALS_MISSING"),
  ready: () => authStatus("READY", { authenticated: true }),
}

function verificationProcess(scenario: () => VerificationScenario) {
  return (_command: string, args: readonly string[]): ProcessOutput => {
    const current = scenario()
    if (args.at(-1) === "doctor") {
      return {
        stdout: envelope("doctor", doctorData({ brokerage: current !== "crypto", crypto: current === "crypto" })),
      }
    }
    const crypto =
      current === "crypto"
        ? { ...authStatus("READY", { authenticated: true }), provider: "crypto" }
        : { ...authStatus("CREDENTIALS_MISSING"), provider: "crypto" }
    return {
      stdout: envelope("auth verify", {
        brokerage: brokerageStatus[current](),
        crypto,
        access_token: "secret-token",
        username: "alice@example.com",
      }),
    }
  }
}

describe("RobinhoodIntegration", () => {
  test("publishes the authenticated global HTTP paths", () => {
    expect(IntegrationPaths).toEqual({
      robinhood: "/global/integrations/robinhood",
      robinhoodInstall: "/global/integrations/robinhood/install",
      robinhoodVerify: "/global/integrations/robinhood/verify",
    })
  })

  test("installs the exact pinned package through Npm and probes v4 doctor before persisting", async () => {
    const executablePath = "/managed/cache/node_modules/.bin/rhx"
    const seen: Array<{ command: string; args: readonly string[]; env: unknown }> = []
    const result = await fixture({
      executablePath,
      process: (command, args, env) => {
        seen.push({ command, args, env })
        return { stdout: envelope("doctor", doctorData()) }
      },
      run: (service) =>
        Effect.gen(function* () {
          const status = yield* service.install()
          expect(status).toMatchObject({
            status: "installed",
            installed: true,
            source: "managed",
            executablePath,
            profile: "default",
            pinnedVersion: "0.4.8",
          })
          expect(status.loginArgs).toEqual(["--profile", "default", "auth", "login"])
        }),
    })

    expect(result.npmCalls).toEqual(["add:rhx@0.4.8", "which:rhx@0.4.8:rhx"])
    expect(seen).toEqual([
      {
        command: executablePath,
        args: ["--json", "--profile", "default", "doctor"],
        env: {
          RH_CRYPTO_API_KEY: "",
          RH_CRYPTO_PRIVATE_KEY_B64: "",
        },
      },
    ])
    const persisted = JSON.parse(result.persistedState ?? "null")
    expect(persisted).toEqual({
      schemaVersion: 1,
      source: "managed",
      executablePath,
      profile: "default",
      installedVersion: "0.4.8",
    })
  })

  test("reports unsupported without invoking Npm or a process", async () => {
    const result = await fixture({
      platform: "linux",
      arch: "arm64",
      executablePath: "/unused/rhx",
      process: () => {
        throw new Error("process should not run")
      },
      run: (service) =>
        Effect.gen(function* () {
          expect(yield* service.status()).toEqual({
            provider: "robinhood",
            package: "rhx",
            pinnedVersion: "0.4.8",
            status: "unsupported",
            supported: false,
            installed: false,
            ready: false,
            brokerage: { configured: false, ready: false, state: "unknown" },
            crypto: { configured: false, ready: false, state: "unknown" },
            message: "Managed rhx installation is not available on this platform.",
          })
          expect(yield* service.install()).toMatchObject({ status: "unsupported", installed: false, supported: false })
        }),
    })
    expect(result.npmCalls).toEqual([])
    expect(result.persistedState).toBeUndefined()
  })

  test("rejects a manual executable whose passive doctor is not output_schema v4", async () => {
    const executablePath = "/opt/bin/rhx"
    const result = await fixture({
      executablePath,
      process: () => ({ stdout: envelope("doctor", doctorData(), "v3") }),
      run: (service) =>
        Effect.gen(function* () {
          const status = yield* service.install({ executablePath, profile: "work" })
          expect(status).toMatchObject({ status: "error", installed: false })
        }),
    })
    expect(result.npmCalls).toEqual([])
    expect(result.persistedState).toBeUndefined()
  })

  test("does not persist an unverified manual path passed directly to verify", async () => {
    const executablePath = "/opt/bin/not-rhx"
    const result = await fixture({
      executablePath,
      process: () => ({ stdout: envelope("auth verify", {}, "v3") }),
      run: (service) =>
        Effect.gen(function* () {
          expect(yield* service.verify({ executablePath, profile: "default" })).toMatchObject({
            status: "error",
            installed: false,
          })
        }),
    })

    expect(result.persistedState).toBeUndefined()
  })

  test("maps MFA and expiry states without persisting rhx secrets", async () => {
    const executablePath = "/opt/bin/rhx"
    let scenario: VerificationScenario = "mfa"
    const result = await fixture({
      executablePath,
      process: verificationProcess(() => scenario),
      run: (service, auth) =>
        Effect.gen(function* () {
          expect(yield* service.install({ executablePath, profile: "work" })).toMatchObject({ status: "installed" })

          expect(yield* service.verify()).toMatchObject({ status: "mfa_required", ready: false })
          expect(auth).toEqual({})

          scenario = "expired"
          expect(yield* service.verify()).toMatchObject({ status: "expired", ready: false })
          expect(auth).toEqual({})
        }),
    })

    expect(result.persistedState).not.toContain("secret-token")
    expect(result.persistedState).not.toContain("alice@example.com")
  })

  test("maps independent crypto and brokerage readiness without storing credentials", async () => {
    const executablePath = "/opt/bin/rhx"
    let scenario: VerificationScenario = "crypto"
    const result = await fixture({
      executablePath,
      process: verificationProcess(() => scenario),
      run: (service, auth) =>
        Effect.gen(function* () {
          expect(yield* service.install({ executablePath, profile: "work" })).toMatchObject({ status: "installed" })
          expect(yield* service.verify()).toMatchObject({
            status: "ready",
            brokerage: { state: "not_configured", ready: false },
            crypto: { state: "ready", ready: true },
          })
          expect(auth[RobinhoodIntegration.connectorAuthID]).toMatchObject({
            metadata: { brokerageReady: "false", cryptoReady: "true" },
          })
          expect(yield* service.promptContext()).toMatchObject({ status: "ready", ready: true })

          scenario = "ready"
          const ready = yield* service.verify()
          expect(ready).toMatchObject({ status: "ready", ready: true, brokerage: { state: "ready", ready: true } })
          expect(auth[RobinhoodIntegration.connectorAuthID]).toMatchObject({
            type: "api",
            key: "finny-rhx-managed-no-secret",
            metadata: {
              keyId: "work",
              endpoint: executablePath,
              label: "Robinhood (rhx)",
              connector: "finny-rhx-integration",
              package: "rhx",
              version: "0.4.8",
              brokerageReady: "true",
              cryptoReady: "false",
              verifiedAt: expect.any(String),
            },
          })

          expect(yield* service.install({ executablePath, profile: "other" })).toMatchObject({
            status: "installed",
            profile: "other",
          })
          expect(auth).toEqual({})

          expect(yield* service.detach()).toMatchObject({ status: "not_installed", installed: false })
          expect(auth).toEqual({})
        }),
    })

    expect(result.persistedState).toBeUndefined()
  })
})
