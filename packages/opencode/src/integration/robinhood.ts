import path from "node:path"
import { Auth } from "@/auth"
import { makeRuntime } from "@/effect/run-service"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { AppProcess } from "@opencode-ai/core/process"
import { Context, DateTime, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"

export const packageName = "rhx" as const
export const pinnedVersion = "0.4.8" as const
export const packageSpec = `${packageName}@${pinnedVersion}` as const
export const connectorAuthID = "robinhood-rhx-connector"

const connectorMarker = "finny-rhx-integration"
const connectorDummyKey = "finny-rhx-managed-no-secret"
const defaultProfile = "default"
const verificationTtlMs = 5 * 60 * 1000
const managedTargets = new Set(["darwin-arm64", "linux-x64", "win32-x64"])

export const State = Schema.Literals([
  "unsupported",
  "not_installed",
  "installing",
  "installed",
  "authenticating",
  "ready",
  "mfa_required",
  "expired",
  "error",
]).annotate({ identifier: "RobinhoodIntegrationState" })
export type State = typeof State.Type

export const CapabilityState = Schema.Literals([
  "unknown",
  "not_configured",
  "configured",
  "ready",
  "mfa_required",
  "expired",
  "error",
]).annotate({ identifier: "RobinhoodIntegrationCapabilityState" })
export type CapabilityState = typeof CapabilityState.Type

export const CapabilityStatus = Schema.Struct({
  configured: Schema.Boolean,
  ready: Schema.Boolean,
  state: CapabilityState,
}).annotate({ identifier: "RobinhoodIntegrationCapabilityStatus" })
export type CapabilityStatus = typeof CapabilityStatus.Type

export const Status = Schema.Struct({
  provider: Schema.Literal("robinhood"),
  package: Schema.Literal(packageName),
  pinnedVersion: Schema.Literal(pinnedVersion),
  status: State,
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  ready: Schema.Boolean,
  source: Schema.optional(Schema.Literals(["managed", "manual"])),
  executablePath: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  loginArgs: Schema.optional(Schema.Array(Schema.String)),
  brokerage: CapabilityStatus,
  crypto: CapabilityStatus,
  message: Schema.optional(Schema.String),
  checkedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "RobinhoodIntegrationStatus" })
export type Status = typeof Status.Type

export const ConfigureInput = Schema.Struct({
  executablePath: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
}).annotate({ identifier: "RobinhoodIntegrationConfigureInput" })
export type ConfigureInput = typeof ConfigureInput.Type

export const PromptContext = Schema.Struct({
  provider: Schema.Literal("robinhood"),
  status: State,
  ready: Schema.Boolean,
  pinnedVersion: Schema.Literal(pinnedVersion),
  capabilities: Schema.Array(Schema.Literals(["stocks", "etfs", "crypto-usd"])),
}).annotate({ identifier: "RobinhoodIntegrationPromptContext" })
export type PromptContext = typeof PromptContext.Type

const StoredMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.Literals(["managed", "manual"]),
  executablePath: Schema.String,
  profile: Schema.String,
  installedVersion: Schema.optional(Schema.String),
  lastStatus: Schema.optional(State),
  brokerageState: Schema.optional(CapabilityState),
  cryptoState: Schema.optional(CapabilityState),
  verifiedAt: Schema.optional(Schema.String),
})
type StoredMetadata = typeof StoredMetadata.Type

const RhxError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retriable: Schema.Boolean,
})

const RhxEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.String,
  provider: Schema.NullOr(Schema.String),
  data: Schema.Unknown,
  error: Schema.NullOr(RhxError),
  meta: Schema.Struct({ output_schema: Schema.Literal("v4") }),
})
type RhxEnvelope = typeof RhxEnvelope.Type

const RhxAuthStatus = Schema.Struct({
  provider: Schema.String,
  authenticated: Schema.Boolean,
  mfa_required: Schema.Boolean,
  state: Schema.String,
  detail: Schema.optional(Schema.String),
})

const DoctorData = Schema.Struct({
  auth: Schema.Struct({
    brokerage: Schema.Struct({
      session_file_exists: Schema.Boolean,
      credentials_present: Schema.Boolean,
      session_ready: Schema.Boolean,
      detail: Schema.optional(Schema.String),
    }),
    crypto: RhxAuthStatus,
  }),
})

const VerifyData = Schema.Struct({
  brokerage: RhxAuthStatus,
  crypto: RhxAuthStatus,
})

class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("RobinhoodIntegrationError", {
  kind: Schema.Literals(["metadata", "input", "install", "process", "schema", "auth"]),
  cause: Schema.optional(Schema.Defect),
}) {}

type Operation = "installing" | "authenticating" | undefined

const unknownCapability = (): CapabilityStatus => ({ configured: false, ready: false, state: "unknown" })
const capability = (state: CapabilityState): CapabilityStatus => ({
  configured: !["unknown", "not_configured"].includes(state),
  ready: state === "ready",
  state,
})

function stateMessage(state: State): string | undefined {
  if (state === "unsupported") return "Managed rhx installation is not available on this platform."
  if (state === "not_installed") return "Install rhx or attach an absolute path to an existing executable."
  if (state === "installing") return "Installing the pinned rhx runtime."
  if (state === "installed") return "rhx is installed. Sign in, then verify the connection."
  if (state === "authenticating") return "Verifying Robinhood authentication."
  if (state === "ready") return "Robinhood is ready."
  if (state === "mfa_required")
    return "Robinhood approval or MFA is required. Run the login command, then verify again."
  if (state === "expired") return "The Robinhood session expired. Run the login command, then verify again."
  if (state === "error") return "The rhx integration could not be checked."
}

function makeStatus(input: {
  managedSupported: boolean
  state: State
  metadata?: StoredMetadata
  brokerage?: CapabilityStatus
  crypto?: CapabilityStatus
  checkedAt?: string
}): Status {
  const metadata = input.metadata
  return {
    provider: "robinhood",
    package: packageName,
    pinnedVersion,
    status: input.state,
    supported: input.managedSupported || metadata?.source === "manual",
    installed: metadata !== undefined,
    ready: input.state === "ready",
    source: metadata?.source,
    executablePath: metadata?.executablePath,
    profile: metadata?.profile,
    loginArgs: metadata ? ["--profile", metadata.profile, "auth", "login"] : undefined,
    brokerage: input.brokerage ?? unknownCapability(),
    crypto: input.crypto ?? unknownCapability(),
    message: stateMessage(input.state),
    checkedAt: input.checkedAt,
  }
}

function normalizeProfile(value?: string): string | undefined {
  const profile = (value ?? defaultProfile).trim()
  return /^[A-Za-z0-9._-]{1,64}$/.test(profile) ? profile : undefined
}

function mapVerifiedCapability(value: typeof RhxAuthStatus.Type): CapabilityStatus {
  if (value.authenticated && value.state === "READY") return capability("ready")
  if (value.mfa_required || value.state === "MFA_REQUIRED_DO_NOT_RETRY") return capability("mfa_required")
  if (value.state === "SESSION_EXPIRED") return capability("expired")
  if (value.state === "CREDENTIALS_MISSING") return capability("not_configured")
  return capability("error")
}

function overallState(brokerage: CapabilityStatus, crypto: CapabilityStatus): State {
  const states = [brokerage.state, crypto.state]
  if (states.includes("ready")) return "ready"
  if (states.includes("mfa_required")) return "mfa_required"
  if (states.includes("expired")) return "expired"
  if (states.includes("error")) return "error"
  return "installed"
}

function verificationIsFresh(verifiedAt: string | undefined, checkedAtMs: number): boolean {
  if (!verifiedAt) return false
  const parsed = Date.parse(verifiedAt)
  return Number.isFinite(parsed) && checkedAtMs >= parsed && checkedAtMs - parsed <= verificationTtlMs
}

function passiveCapability(
  configured: boolean,
  stored?: CapabilityState,
  verifiedAt?: string,
  checkedAtMs = Date.now(),
): CapabilityStatus {
  if (!configured) return capability("not_configured")
  if (stored === "ready" && verificationIsFresh(verifiedAt, checkedAtMs)) return capability("ready")
  if (stored && ["mfa_required", "expired", "error"].includes(stored)) return capability(stored)
  return capability("configured")
}

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  readonly install: (input?: ConfigureInput) => Effect.Effect<Status>
  readonly verify: (input?: ConfigureInput) => Effect.Effect<Status>
  readonly detach: () => Effect.Effect<Status>
  readonly promptContext: () => Effect.Effect<PromptContext>
}

export class Service extends Context.Service<Service, Interface>()("@finny/RobinhoodIntegration") {}
export const use = serviceUse(Service)

export interface LayerOptions {
  readonly platform?: string
  readonly arch?: string
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const npm = yield* Npm.Service
      const processService = yield* AppProcess.Service
      const auth = yield* Auth.Service
      const operation = yield* Ref.make<Operation>(undefined)
      const lock = yield* Semaphore.make(1)
      const platformKey = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`
      const managedSupported = managedTargets.has(platformKey)
      const stateFile = path.join(global.state, "integrations", "robinhood.json")

      const readMetadata = Effect.fnUntraced(function* () {
        if (!(yield* fs.existsSafe(stateFile))) return undefined
        const raw = yield* fs
          .readJson(stateFile)
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "metadata", cause })))
        return yield* Schema.decodeUnknownEffect(StoredMetadata)(raw).pipe(
          Effect.mapError((cause) => new IntegrationError({ kind: "metadata", cause })),
        )
      })

      const writeMetadata = Effect.fnUntraced(function* (metadata: StoredMetadata) {
        yield* fs
          .ensureDir(path.dirname(stateFile))
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "metadata", cause })))
        yield* fs
          .writeJson(stateFile, metadata, 0o600)
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "metadata", cause })))
      })

      const now = Effect.fnUntraced(function* () {
        return (yield* DateTime.nowAsDate).toISOString()
      })

      const runRhx = Effect.fnUntraced(function* (
        metadata: StoredMetadata,
        expectedCommand: "doctor" | "auth verify",
        argv: readonly string[],
      ) {
        const result = yield* processService
          .run(
            ChildProcess.make(metadata.executablePath, ["--json", "--profile", metadata.profile, ...argv], {
              extendEnv: true,
              // A ready crypto status must be usable by the secret-free
              // strategy worker, so ignore env-only keys and verify RHX's
              // OS-keyring credential path.
              env: {
                RH_CRYPTO_API_KEY: "",
                RH_CRYPTO_PRIVATE_KEY_B64: "",
              },
              stdin: "ignore",
            }),
            { timeout: "15 seconds", maxOutputBytes: 1024 * 1024, maxErrorBytes: 1024 * 1024 },
          )
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "process", cause })))
        if (result.stdoutTruncated || result.stderrTruncated) return yield* new IntegrationError({ kind: "schema" })
        // RHX writes its JSON error envelope to stdout. Prefer stdout on every
        // exit code, with stderr only as a compatibility fallback.
        const stdout = result.stdout.toString("utf8").trim()
        const stderr = result.stderr.toString("utf8").trim()
        const raw = stdout || stderr
        const json = yield* Effect.try({
          try: () => JSON.parse(raw),
          catch: (cause) => new IntegrationError({ kind: "schema", cause }),
        })
        const envelope = yield* Schema.decodeUnknownEffect(RhxEnvelope)(json).pipe(
          Effect.mapError((cause) => new IntegrationError({ kind: "schema", cause })),
        )
        if (envelope.command !== expectedCommand || envelope.provider !== null) {
          return yield* new IntegrationError({ kind: "schema" })
        }
        if (result.exitCode !== 0 || !envelope.ok || envelope.error !== null) {
          return yield* new IntegrationError({ kind: "process" })
        }
        return envelope
      })

      const statusInternal = Effect.fnUntraced(function* () {
        const metadata = yield* readMetadata()
        const current = yield* Ref.get(operation)
        if (current) return makeStatus({ managedSupported, metadata, state: current })
        if (!metadata) {
          return makeStatus({ managedSupported, state: managedSupported ? "not_installed" : "unsupported" })
        }
        const envelope = yield* runRhx(metadata, "doctor", ["doctor"])
        const data = yield* Schema.decodeUnknownEffect(DoctorData)(envelope.data).pipe(
          Effect.mapError((cause) => new IntegrationError({ kind: "schema", cause })),
        )
        const brokerageConfigured = data.auth.brokerage.session_ready
        const cryptoConfigured = data.auth.crypto.authenticated
        const checkedAt = yield* now()
        const checkedAtMs = Date.parse(checkedAt)
        const brokerage = passiveCapability(
          brokerageConfigured,
          metadata.brokerageState,
          metadata.verifiedAt,
          checkedAtMs,
        )
        const crypto = passiveCapability(cryptoConfigured, metadata.cryptoState, metadata.verifiedAt, checkedAtMs)
        const state = overallState(brokerage, crypto)
        return makeStatus({ managedSupported, metadata, state, brokerage, crypto, checkedAt })
      })

      const status = Effect.fn("RobinhoodIntegration.status")(function* () {
        return yield* statusInternal().pipe(
          Effect.catch(() =>
            readMetadata().pipe(
              Effect.map((metadata) => makeStatus({ managedSupported, metadata, state: "error" })),
              Effect.catch(() => Effect.succeed(makeStatus({ managedSupported, state: "error" }))),
            ),
          ),
        )
      })

      const install = Effect.fn("RobinhoodIntegration.install")(function* (input: ConfigureInput = {}) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const profile = normalizeProfile(input.profile)
            if (!profile) return makeStatus({ managedSupported, state: "error" })
            yield* Ref.set(operation, "installing")
            const metadata = yield* Effect.gen(function* () {
              if (input.executablePath !== undefined) {
                const executablePath = input.executablePath.trim()
                if (!path.isAbsolute(executablePath)) return yield* new IntegrationError({ kind: "input" })
                return {
                  schemaVersion: 1 as const,
                  source: "manual" as const,
                  executablePath,
                  profile,
                }
              }
              if (!managedSupported) return undefined
              yield* npm
                .add(packageSpec)
                .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "install", cause })))
              const executable = yield* npm.which(packageSpec, packageName)
              if (Option.isNone(executable)) return yield* new IntegrationError({ kind: "install" })
              return {
                schemaVersion: 1 as const,
                source: "managed" as const,
                executablePath: executable.value,
                profile,
                installedVersion: pinnedVersion,
              }
            })
            if (!metadata) return makeStatus({ managedSupported, state: "unsupported" })
            const envelope = yield* runRhx(metadata, "doctor", ["doctor"])
            const doctor = yield* Schema.decodeUnknownEffect(DoctorData)(envelope.data).pipe(
              Effect.mapError((cause) => new IntegrationError({ kind: "schema", cause })),
            )
            yield* writeMetadata(metadata)
            return makeStatus({
              managedSupported,
              metadata,
              state: "installed",
              brokerage: passiveCapability(doctor.auth.brokerage.session_ready),
              crypto: passiveCapability(doctor.auth.crypto.authenticated),
              checkedAt: yield* now(),
            })
          }).pipe(
            Effect.catch(() =>
              readMetadata().pipe(
                Effect.map((metadata) => makeStatus({ managedSupported, metadata, state: "error" })),
                Effect.catch(() => Effect.succeed(makeStatus({ managedSupported, state: "error" }))),
              ),
            ),
            Effect.ensuring(Ref.set(operation, undefined)),
          ),
        )
      })

      const saveConnectorAccount = Effect.fnUntraced(function* (
        metadata: StoredMetadata,
        brokerageReady: boolean,
        cryptoReady: boolean,
      ) {
        yield* auth
          .set(connectorAuthID, {
            type: "api",
            key: connectorDummyKey,
            metadata: {
              keyId: metadata.profile,
              endpoint: metadata.executablePath,
              label: "Robinhood (rhx)",
              connector: connectorMarker,
              package: packageName,
              version: pinnedVersion,
              brokerageReady: String(brokerageReady),
              cryptoReady: String(cryptoReady),
              verifiedAt: metadata.verifiedAt ?? "",
            },
          })
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "auth", cause })))
      })

      const removeConnectorAccounts = Effect.fnUntraced(function* () {
        const entries = yield* auth
          .all()
          .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "auth", cause })))
        for (const [id, entry] of Object.entries(entries)) {
          if (entry.type !== "api" || entry.metadata?.connector !== connectorMarker) continue
          yield* auth.remove(id).pipe(Effect.mapError((cause) => new IntegrationError({ kind: "auth", cause })))
        }
      })

      const verify = Effect.fn("RobinhoodIntegration.verify")(function* (input: ConfigureInput = {}) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const prior = yield* readMetadata()
            const profile = normalizeProfile(input.profile ?? prior?.profile)
            if (!profile) return yield* new IntegrationError({ kind: "input" })
            const metadata: StoredMetadata | undefined = input.executablePath
              ? {
                  schemaVersion: 1,
                  source: "manual",
                  executablePath: input.executablePath.trim(),
                  profile,
                }
              : prior
                ? { ...prior, profile }
                : undefined
            if (!metadata)
              return makeStatus({ managedSupported, state: managedSupported ? "not_installed" : "unsupported" })
            if (!path.isAbsolute(metadata.executablePath)) return yield* new IntegrationError({ kind: "input" })
            yield* Ref.set(operation, "authenticating")
            const envelope = yield* runRhx(metadata, "auth verify", ["auth", "verify"])
            const data = yield* Schema.decodeUnknownEffect(VerifyData)(envelope.data).pipe(
              Effect.mapError((cause) => new IntegrationError({ kind: "schema", cause })),
            )
            const brokerage = mapVerifiedCapability(data.brokerage)
            const crypto = mapVerifiedCapability(data.crypto)
            const state = overallState(brokerage, crypto)
            const verifiedAt = yield* now()
            const next: StoredMetadata = {
              schemaVersion: 1,
              source: metadata.source,
              executablePath: metadata.executablePath,
              profile: metadata.profile,
              installedVersion: metadata.installedVersion,
              lastStatus: state,
              brokerageState: brokerage.state,
              cryptoState: crypto.state,
              verifiedAt,
            }
            yield* writeMetadata(next)
            // Readiness is stored as nonsecret strings so account selection can
            // filter stock and crypto deployments independently.
            if (state === "ready") yield* saveConnectorAccount(next, brokerage.ready, crypto.ready)
            else yield* removeConnectorAccounts()
            return makeStatus({ managedSupported, metadata: next, state, brokerage, crypto, checkedAt: verifiedAt })
          }).pipe(
            Effect.catch(() =>
              readMetadata().pipe(
                Effect.map((metadata) => makeStatus({ managedSupported, metadata, state: "error" })),
                Effect.catch(() => Effect.succeed(makeStatus({ managedSupported, state: "error" }))),
              ),
            ),
            Effect.ensuring(Ref.set(operation, undefined)),
          ),
        )
      })

      const detach = Effect.fn("RobinhoodIntegration.detach")(function* () {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* removeConnectorAccounts()
            yield* fs
              .remove(stateFile, { force: true })
              .pipe(Effect.mapError((cause) => new IntegrationError({ kind: "metadata", cause })))
            return makeStatus({ managedSupported, state: managedSupported ? "not_installed" : "unsupported" })
          }).pipe(Effect.catch(() => Effect.succeed(makeStatus({ managedSupported, state: "error" })))),
        )
      })

      const promptContext = Effect.fn("RobinhoodIntegration.promptContext")(function* () {
        const current = yield* statusInternal().pipe(
          Effect.catch(() => Effect.succeed(makeStatus({ managedSupported, state: "error" }))),
        )
        const capabilities: Array<"stocks" | "etfs" | "crypto-usd"> = []
        if (current.brokerage.ready) capabilities.push("stocks", "etfs")
        if (current.crypto.ready) capabilities.push("crypto-usd")
        return {
          provider: "robinhood" as const,
          status: current.status,
          ready: current.ready,
          pinnedVersion,
          capabilities,
        }
      })

      return Service.of({ status, install, verify, detach, promptContext })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(
  Layer.provide(Npm.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
  Layer.provide(Auth.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)
export const getStatus = () => runPromise((service) => service.status())
export const getPromptContext = () => runPromise((service) => service.promptContext())

export const node = LayerNode.make(layer, [Npm.node, AppProcess.node, FSUtil.node, Global.node, Auth.node])

export * as RobinhoodIntegration from "./robinhood"
