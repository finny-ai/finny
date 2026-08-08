import { createHash } from "node:crypto"
import { Context, Effect, Layer, RcMap, Schema, TxReentrantLock } from "effect"
import { Storage } from "@/storage/storage"
import { BacktestStore, type Manifest } from "@/backtest/store"
import {
  AdvanceInput,
  ArtifactInput,
  Budget,
  CandidateInput,
  ContinueInput,
  CreateInput,
  StopRules,
} from "./campaign-contract"

export * from "./campaign-contract"

type Candidate = typeof CandidateInput.Type & {
  sessionID?: string
  status: "queued" | "running" | "idle" | "aborted" | "failed"
  turns: number
  manifestIDs: string[]
  lastOperationID?: string
}

export type CampaignEvent = {
  cursor: number
  time: number
  type: string
  candidateID?: string
  sessionID?: string
  data?: Record<string, unknown>
}

export type Campaign = {
  id: string
  goal: string
  agent: string
  status: "active" | "stopped" | "aborted"
  reason?: string
  createdAt: number
  updatedAt: number
  budget: typeof Budget.Type
  stop: typeof StopRules.Type
  rounds: number
  candidates: Candidate[]
  operations: Record<string, { kind: string; requestHash: string; result?: unknown }>
  events: CampaignEvent[]
  nextCursor: number
}

export type RankedCandidate = {
  rank: number
  candidateID: string
  sessionID?: string
  manifestID: string
  algorithmID: string
  algorithmName: string
  assumptionsKey: string
  sharpeRatio: number
  maxDrawdown: number
  totalReturn: number
  eligibilityStatus?: string
  artifactRefs: string[]
}

export type Comparison = {
  campaignID: string
  assumptionsKey: string | null
  comparable: boolean
  excluded: Array<{ candidateID: string; manifestID: string; reason: string }>
  ranking: RankedCandidate[]
  promotion: { allowed: false; reason: string }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("CampaignNotFound", {
  message: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("CampaignConflict", {
  message: Schema.String,
}) {}

export class BudgetError extends Schema.TaggedErrorClass<BudgetError>()("CampaignBudgetExceeded", {
  message: Schema.String,
}) {}

export type Error = NotFoundError | ConflictError | BudgetError

export class ArtifactService extends Context.Service<
  ArtifactService,
  { readonly get: (id: string) => Effect.Effect<Manifest | null> }
>()("@finny/CampaignArtifactStore") {}

export const artifactLayer = Layer.succeed(ArtifactService, {
  get: (id) => Effect.promise(() => BacktestStore.get(id)),
})

export type RuntimeSession = {
  id: string
  metadata?: Record<string, unknown>
  cost: number
  tokens: number
}

export class RuntimeService extends Context.Service<
  RuntimeService,
  {
    readonly listRoots: (limit: number) => Effect.Effect<RuntimeSession[]>
    readonly createRoot: (input: {
      title: string
      agent: string
      metadata: Record<string, unknown>
    }) => Effect.Effect<RuntimeSession>
    readonly getUsage: (sessionID: string) => Effect.Effect<{ cost: number; tokens: number }>
    readonly status: (sessionID: string) => Effect.Effect<string>
    readonly prompt: (sessionID: string, operationID: string, agent: string, text: string) => Effect.Effect<void>
    readonly abort: (sessionID: string) => Effect.Effect<void>
  }
>()("@finny/CampaignRuntime") {}

const key = (id: string) => ["campaign", id]
const idFor = (operationID: string) => `cmp_${createHash("sha256").update(operationID).digest("hex").slice(0, 20)}`

function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, canonical(value)]),
  )
}

const canonicalJSON = (input: unknown) => JSON.stringify(canonical(input))
const requestHash = (input: unknown) => createHash("sha256").update(canonicalJSON(input)).digest("hex")

function assumptionKey(manifest: Manifest) {
  return canonicalJSON({
    symbol: manifest.symbol ?? null,
    params: manifest.params,
    assumptions: manifest.assumptions,
  })
}

function artifacts(manifest: Manifest) {
  return [
    manifest.dir,
    manifest.artifacts.equityCurve,
    manifest.artifacts.trades,
    manifest.artifacts.sourceArtifacts,
  ].filter((item): item is string => Boolean(item))
}

function emit(state: Campaign, type: string, input: Omit<CampaignEvent, "cursor" | "time" | "type"> = {}) {
  state.events.push({ cursor: state.nextCursor++, time: Date.now(), type, ...input })
  state.updatedAt = Date.now()
}

function usage(state: Campaign) {
  return {
    sessions: state.candidates.filter((candidate) => candidate.sessionID).length,
    turns: state.candidates.reduce((sum, candidate) => sum + candidate.turns, 0),
  }
}

export interface Interface {
  readonly create: (input: typeof CreateInput.Type) => Effect.Effect<Campaign, Error>
  readonly get: (id: string) => Effect.Effect<Campaign, Error>
  readonly start: (id: string, operationID: string, candidateID: string) => Effect.Effect<Campaign, Error>
  readonly continueSession: (id: string, input: typeof ContinueInput.Type) => Effect.Effect<Campaign, Error>
  readonly abort: (id: string, operationID: string, candidateID?: string) => Effect.Effect<Campaign, Error>
  readonly recordArtifact: (id: string, input: typeof ArtifactInput.Type) => Effect.Effect<Campaign, Error>
  readonly events: (id: string, after?: number) => Effect.Effect<CampaignEvent[], Error>
  readonly wait: (id: string, after?: number, timeoutMs?: number) => Effect.Effect<CampaignEvent[], Error>
  readonly compare: (id: string) => Effect.Effect<Comparison, Error>
  readonly advance: (id: string, input: typeof AdvanceInput.Type) => Effect.Effect<Campaign, Error>
}

export class Service extends Context.Service<Service, Interface>()("@finny/Campaign") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const runtime = yield* RuntimeService
    const artifactStore = yield* ArtifactService
    const locks = yield* RcMap.make({ lookup: () => TxReentrantLock.make(), idleTimeToLive: 0 })

    const withLock = <A, E>(id: string, effect: Effect.Effect<A, E>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RcMap.get(locks, id)
          return yield* TxReentrantLock.withWriteLock(lock, effect)
        }),
      )

    const get = Effect.fn("Campaign.get")(function* (id: string) {
      return yield* storage
        .read<Campaign>(key(id))
        .pipe(Effect.mapError(() => new NotFoundError({ message: `Campaign not found: ${id}` })))
    })

    const save = Effect.fn("Campaign.save")(function* (state: Campaign) {
      yield* storage.write(key(state.id), state).pipe(Effect.orDie)
      return state
    })

    const create = Effect.fn("Campaign.create")(function* (input: typeof CreateInput.Type) {
      const id = idFor(input.operationID)
      return yield* withLock(
        id,
        Effect.gen(function* () {
          const existing = yield* get(id).pipe(Effect.option)
          if (existing._tag === "Some") {
            if (existing.value.operations[input.operationID]?.requestHash !== requestHash(input))
              return yield* new ConflictError({
                message: `operationID ${input.operationID} was reused with different input`,
              })
            return existing.value
          }
          const now = Date.now()
          const state: Campaign = {
            id,
            goal: input.goal,
            agent: input.agent ?? "finny",
            status: "active",
            createdAt: now,
            updatedAt: now,
            budget: input.budget,
            stop: input.stop,
            rounds: 0,
            candidates: input.candidates.map((candidate) => ({
              ...candidate,
              status: "queued",
              turns: 0,
              manifestIDs: [],
            })),
            operations: { [input.operationID]: { kind: "create", requestHash: requestHash(input), result: id } },
            events: [],
            nextCursor: 1,
          }
          emit(state, "campaign.created", { data: { goal: state.goal } })
          return yield* save(state)
        }),
      )
    })

    const mutate = Effect.fn("Campaign.mutate")(function* <A>(
      id: string,
      operationID: string,
      kind: string,
      fingerprint: unknown,
      fn: (state: Campaign) => Effect.Effect<A, Error>,
    ) {
      return yield* withLock(
        id,
        Effect.gen(function* () {
          const state = yield* get(id)
          const previous = state.operations[operationID]
          const fingerprintHash = requestHash({ kind, fingerprint })
          if (previous) {
            if (previous.requestHash !== fingerprintHash)
              return yield* new ConflictError({ message: `operationID ${operationID} was reused with different input` })
            return state
          }
          if (state.status !== "active" && kind !== "abort")
            return yield* new ConflictError({
              message: `Campaign is ${state.status}: ${state.reason ?? "stopping rule"}`,
            })
          yield* fn(state)
          state.operations[operationID] = { kind, requestHash: fingerprintHash }
          return yield* save(state)
        }),
      )
    })

    const assertBudget = (state: Campaign, extraSessions: number, extraTurns: number) =>
      Effect.gen(function* () {
        const used = usage(state)
        if (used.sessions + extraSessions > state.budget.maxSessions)
          return yield* new BudgetError({ message: "maxSessions exceeded" })
        if (used.turns + extraTurns > state.budget.maxTurns)
          return yield* new BudgetError({ message: "maxTurns exceeded" })
        if (Date.now() - state.createdAt >= state.budget.maxWallClockMs)
          return yield* new BudgetError({ message: "maxWallClockMs exceeded" })
        const infos = yield* Effect.forEach(
          state.candidates.flatMap((candidate) => (candidate.sessionID ? [candidate.sessionID] : [])),
          runtime.getUsage,
        )
        const totalCost = infos.reduce((sum, item) => sum + item.cost, 0)
        const totalTokens = infos.reduce((sum, item) => sum + item.tokens, 0)
        if (totalCost >= state.budget.maxCost) return yield* new BudgetError({ message: "maxCost exceeded" })
        if (totalTokens >= state.budget.maxTokens) return yield* new BudgetError({ message: "maxTokens exceeded" })
      })

    const dispatch = Effect.fn("Campaign.dispatch")(function* (
      state: Campaign,
      candidate: Candidate,
      operationID: string,
      text: string,
    ) {
      yield* assertBudget(state, candidate.sessionID ? 0 : 1, 1)
      if (!candidate.sessionID) {
        const operationTag = `${state.id}:${candidate.id}`
        const known = (yield* runtime.listRoots(state.budget.maxSessions + 20)).find(
          (item) => item.metadata?.campaignOperation === operationTag,
        )
        const session =
          known ??
          (yield* runtime.createRoot({
            title: `Campaign ${state.id}: ${candidate.id}`,
            agent: state.agent,
            metadata: { campaignID: state.id, candidateID: candidate.id, campaignOperation: operationTag },
          }))
        candidate.sessionID = session.id
        emit(state, "session.created", { candidateID: candidate.id, sessionID: session.id })
      }
      candidate.status = "running"
      candidate.lastOperationID = operationID
      candidate.turns += 1
      emit(state, "session.prompted", { candidateID: candidate.id, sessionID: candidate.sessionID })
      yield* save(state)
      yield* runtime.prompt(candidate.sessionID, operationID, state.agent, text)
    })

    const start = (id: string, operationID: string, candidateID: string) =>
      mutate(id, operationID, "start", { candidateID }, (state) =>
        Effect.gen(function* () {
          const candidate = state.candidates.find((item) => item.id === candidateID)
          if (!candidate) return yield* new NotFoundError({ message: `Candidate not found: ${candidateID}` })
          const text = `${state.goal}\n\nCandidate assignment:\n${candidate.prompt}`
          if (candidate.lastOperationID === operationID && candidate.sessionID) {
            yield* runtime.prompt(candidate.sessionID, operationID, state.agent, text)
            return
          }
          if (candidate.status !== "queued")
            return yield* new ConflictError({ message: `Candidate is ${candidate.status}` })
          yield* dispatch(state, candidate, operationID, text)
        }),
      )

    const continueSession = (id: string, input: typeof ContinueInput.Type) =>
      mutate(id, input.operationID, "continue", input, (state) =>
        Effect.gen(function* () {
          const candidate = state.candidates.find((item) => item.id === input.candidateID)
          if (!candidate?.sessionID)
            return yield* new NotFoundError({ message: `Active candidate not found: ${input.candidateID}` })
          if (candidate.lastOperationID === input.operationID) {
            yield* runtime.prompt(candidate.sessionID, input.operationID, state.agent, input.prompt)
            return
          }
          const status = yield* runtime.status(candidate.sessionID)
          if (status !== "idle") return yield* new ConflictError({ message: `Session is ${status}` })
          candidate.status = "idle"
          yield* dispatch(state, candidate, input.operationID, input.prompt)
        }),
      )

    const abort = (id: string, operationID: string, candidateID?: string) =>
      mutate(id, operationID, "abort", { candidateID }, (state) =>
        Effect.gen(function* () {
          const targets = candidateID ? state.candidates.filter((item) => item.id === candidateID) : state.candidates
          if (candidateID && targets.length === 0)
            return yield* new NotFoundError({ message: `Candidate not found: ${candidateID}` })
          for (const candidate of targets) {
            if (candidate.sessionID) yield* runtime.abort(candidate.sessionID)
            candidate.status = "aborted"
            emit(state, "session.aborted", { candidateID: candidate.id, sessionID: candidate.sessionID })
          }
          if (!candidateID) {
            state.status = "aborted"
            state.reason = "aborted by harness"
            emit(state, "campaign.aborted")
          }
        }),
      )

    const recordArtifact = (id: string, input: typeof ArtifactInput.Type) =>
      mutate(id, input.operationID, "recordArtifact", input, (state) =>
        Effect.gen(function* () {
          const candidate = state.candidates.find((item) => item.id === input.candidateID)
          if (!candidate) return yield* new NotFoundError({ message: `Candidate not found: ${input.candidateID}` })
          const manifest = yield* artifactStore.get(input.manifestID)
          if (!manifest || manifest.results.runKind !== "crucible_2_0")
            return yield* new ConflictError({ message: `Crucible manifest not found: ${input.manifestID}` })
          candidate.manifestIDs.push(input.manifestID)
          candidate.status = "idle"
          emit(state, "candidate.artifact.recorded", {
            candidateID: candidate.id,
            sessionID: candidate.sessionID,
            data: { manifestID: input.manifestID },
          })
        }),
      )

    const events = Effect.fn("Campaign.events")(function* (id: string, after = 0) {
      return (yield* get(id)).events.filter((event) => event.cursor > after)
    })

    const wait = Effect.fn("Campaign.wait")(function* (id: string, after = 0, timeoutMs = 0) {
      const deadline = Date.now() + timeoutMs
      do {
        const found = yield* events(id, after)
        if (found.length || Date.now() >= deadline) return found
        yield* Effect.sleep("25 millis")
      } while (true)
    })

    const compare = Effect.fn("Campaign.compare")(function* (id: string) {
      const state = yield* get(id)
      const loaded = yield* Effect.forEach(
        state.candidates.flatMap((candidate) => candidate.manifestIDs.map((manifestID) => ({ candidate, manifestID }))),
        ({ candidate, manifestID }) =>
          artifactStore.get(manifestID).pipe(Effect.map((manifest) => ({ candidate, manifestID, manifest }))),
      )
      const valid = loaded.filter((item): item is typeof item & { manifest: Manifest } => item.manifest !== null)
      const canonical = valid[0] ? assumptionKey(valid[0].manifest) : null
      const excluded = loaded
        .filter((item) => !item.manifest || assumptionKey(item.manifest) !== canonical)
        .map((item) => ({
          candidateID: item.candidate.id,
          manifestID: item.manifestID,
          reason: item.manifest ? "request assumptions differ" : "manifest missing",
        }))
      const ranking = valid
        .filter((item) => assumptionKey(item.manifest) === canonical)
        .sort(
          (a, b) =>
            b.manifest.results.sharpeRatio - a.manifest.results.sharpeRatio ||
            a.manifest.results.maxDrawdown - b.manifest.results.maxDrawdown ||
            b.manifest.results.totalReturn - a.manifest.results.totalReturn ||
            a.manifest.id.localeCompare(b.manifest.id),
        )
        .map((item, index) => ({
          rank: index + 1,
          candidateID: item.candidate.id,
          sessionID: item.candidate.sessionID,
          manifestID: item.manifest.id,
          algorithmID: item.manifest.algorithmId,
          algorithmName: item.manifest.algorithmName,
          assumptionsKey: assumptionKey(item.manifest),
          sharpeRatio: item.manifest.results.sharpeRatio,
          maxDrawdown: item.manifest.results.maxDrawdown,
          totalReturn: item.manifest.results.totalReturn,
          eligibilityStatus: item.manifest.results.eligibilityStatus,
          artifactRefs: artifacts(item.manifest),
        }))
      return {
        campaignID: id,
        assumptionsKey: canonical,
        comparable: ranking.length > 0 && excluded.length === 0,
        excluded,
        ranking,
        promotion: {
          allowed: false as const,
          reason: "Paper/live promotion requires a separate explicit approval gate.",
        },
      }
    })

    const advance = (id: string, input: typeof AdvanceInput.Type) =>
      mutate(id, input.operationID, "advance", input, (state) =>
        Effect.gen(function* () {
          for (const candidate of state.candidates) {
            if (candidate.status === "queued") {
              yield* dispatch(
                state,
                candidate,
                input.operationID,
                `${state.goal}\n\nCandidate assignment:\n${candidate.prompt}`,
              )
              return
            }
          }
          const recovering = state.candidates.find((candidate) => candidate.lastOperationID === input.operationID)
          if (recovering?.sessionID) {
            yield* runtime.prompt(
              recovering.sessionID,
              input.operationID,
              state.agent,
              input.improvementPrompt ??
                "Improve the current candidate while preserving the exact prior backtest request assumptions. Save and run a new Crucible result, then report its manifest ID.",
            )
            return
          }
          const report = yield* compare(id)
          const best = report.ranking[0]
          const meetsTarget =
            best &&
            (state.stop.targetSharpe === undefined || best.sharpeRatio >= state.stop.targetSharpe) &&
            (state.stop.maxDrawdown === undefined || best.maxDrawdown <= state.stop.maxDrawdown)
          if (meetsTarget || state.rounds >= state.stop.maxRounds) {
            state.status = "stopped"
            state.reason = meetsTarget ? "quality target reached" : "maxRounds reached"
            emit(state, "campaign.stopped", { data: { reason: state.reason } })
            return
          }
          if (!best) return yield* new ConflictError({ message: "No comparable Crucible result is available" })
          const candidate = state.candidates.find((item) => item.id === best.candidateID)!
          state.rounds += 1
          yield* dispatch(
            state,
            candidate,
            input.operationID,
            input.improvementPrompt ??
              `Improve the current candidate while preserving the exact prior backtest request assumptions. Save and run a new Crucible result, then report its manifest ID.`,
          )
        }),
      )

    return {
      create,
      get,
      start,
      continueSession,
      abort,
      recordArtifact,
      events,
      wait,
      compare,
      advance,
    } satisfies Interface
  }),
)

export * as CampaignController from "./campaign"
