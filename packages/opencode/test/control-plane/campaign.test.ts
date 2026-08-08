import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Manifest } from "../../src/backtest/store"
import { CampaignController } from "../../src/control-plane/campaign"
import { Storage } from "../../src/storage/storage"

function manifest(id: string, sharpeRatio: number, maxDrawdown: number, totalReturn: number): Manifest {
  return {
    id,
    source: "run",
    algorithmId: `algo-${id}`,
    algorithmName: `Fixture ${id}`,
    algorithmVersion: 1,
    symbol: "SPY",
    params: { duration: "30d", interval: "5m", capital: "100000" },
    assumptions: { feeBps: 1, slippageBps: 2, fillModel: "next_open" },
    results: {
      totalReturn,
      maxDrawdown,
      annualizedVolatility: 0.1,
      sharpeRatio,
      endingEquity: 100_000 * (1 + totalReturn),
      totalTrades: 10,
      winRate: 0.6,
      profitFactor: 1.2,
      productLabel: "Crucible 2.0",
      runKind: "crucible_2_0",
      eligibilityStatus: "research_only",
    },
    benchmark: null,
    alpha: null,
    artifacts: { equityCurve: `${id}/equity.csv`, trades: `${id}/trades.csv`, sourceArtifacts: null },
    timestamp: 1,
  }
}

describe("campaign control plane deterministic fixture", () => {
  test("coordinates isolated sessions, targeted continuation, restart idempotency, budgets, and comparison", async () => {
    const files = new Map<string, unknown>()
    const created: Array<{ id: string; metadata?: Record<string, unknown> }> = []
    const prompted: Array<{ sessionID: string; text: string }> = []
    const deliveredOperations = new Set<string>()
    const manifests = new Map([
      ["run-a", manifest("run-a", 1.2, 0.12, 0.15)],
      ["run-b", manifest("run-b", 1.6, 0.09, 0.13)],
    ])

    const storage = Layer.mock(Storage.Service)({
      read: <T>(key: string[]) => {
        const value = files.get(key.join("/"))
        return value === undefined
          ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
          : Effect.succeed(structuredClone(value) as T)
      },
      write: (key, value) => Effect.sync(() => void files.set(key.join("/"), structuredClone(value))),
      update: () => Effect.die("unexpected update"),
      remove: () => Effect.void,
      list: () => Effect.succeed([]),
    })
    const runtime = Layer.succeed(CampaignController.RuntimeService, {
      listRoots: () => Effect.succeed(created.map((item) => ({ ...item, cost: 0, tokens: 0 }))),
      createRoot: (input) =>
        Effect.sync(() => {
          const session = { id: `ses_fixture_${created.length + 1}`, metadata: input?.metadata }
          created.push(session)
          return { ...session, cost: 0, tokens: 0 }
        }),
      getUsage: () => Effect.succeed({ cost: 0, tokens: 0 }),
      prompt: (sessionID, _operationID, _agent, text) =>
        Effect.sync(() => {
          if (deliveredOperations.has(_operationID)) return
          deliveredOperations.add(_operationID)
          prompted.push({ sessionID, text })
        }),
      abort: () => Effect.void,
      status: () => Effect.succeed("idle"),
    })
    const artifacts = Layer.succeed(CampaignController.ArtifactService, {
      get: (id: string) => Effect.succeed(manifests.get(id) ?? null),
    })
    const dependencies = Layer.mergeAll(storage, runtime, artifacts)
    const campaignLayer = CampaignController.layer.pipe(Layer.provide(dependencies))

    const input = {
      operationID: "fixture-create",
      goal: "Find the best deterministic SPY strategy",
      candidates: [
        { id: "a", prompt: "Test A" },
        { id: "b", prompt: "Test B" },
        { id: "c", prompt: "Test C" },
      ] as const,
      budget: { maxSessions: 2, maxTurns: 4, maxTokens: 10_000, maxCost: 10, maxWallClockMs: 60_000 },
      stop: { maxRounds: 1 },
      agent: "finny",
    }

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CampaignController.Service
        const campaign = yield* service.create(input)
        yield* service.start(campaign.id, "start-a", "a")
        yield* service.start(campaign.id, "start-a", "a")
        yield* service.continueSession(campaign.id, {
          operationID: "continue-a",
          candidateID: "a",
          prompt: "Only continue candidate A",
        })
        yield* service.start(campaign.id, "start-b", "b")
        yield* Effect.sleep("10 millis")
        return campaign.id
      }).pipe(Effect.provide(campaignLayer)),
    )

    expect(created.map((item) => item.id)).toEqual(["ses_fixture_1", "ses_fixture_2"])
    expect(prompted.map((item) => item.sessionID)).toEqual(["ses_fixture_1", "ses_fixture_1", "ses_fixture_2"])

    // Simulate a process crash after the deterministic prompt reached the session but before
    // the operation ledger's final commit. The fresh layer below must reconcile, not dispatch twice.
    const persisted = structuredClone(files.get(`campaign/${first}`)) as CampaignController.Campaign
    delete persisted.operations["start-b"]
    files.set(`campaign/${first}`, persisted)

    await expect(
      Effect.runPromise(
        CampaignController.Service.use((service) => service.start(first, "start-c", "c")).pipe(
          Effect.provide(campaignLayer),
        ),
      ),
    ).rejects.toThrow("maxSessions exceeded")

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CampaignController.Service
        yield* service.create(input)
        yield* service.start(first, "start-b", "b")
        yield* service.recordArtifact(first, { operationID: "artifact-a", candidateID: "a", manifestID: "run-a" })
        yield* service.recordArtifact(first, { operationID: "artifact-b", candidateID: "b", manifestID: "run-b" })
        return {
          state: yield* service.get(first),
          report: yield* service.compare(first),
          events: yield* service.wait(first, 0, 0),
        }
      }).pipe(Effect.provide(campaignLayer)),
    )

    expect(created).toHaveLength(2)
    expect(recovered.state.candidates.find((item) => item.id === "a")?.turns).toBe(2)
    expect(recovered.report.comparable).toBe(true)
    expect(recovered.report.ranking.map((item) => item.candidateID)).toEqual(["b", "a"])
    expect(recovered.report.promotion.allowed).toBe(false)
    expect(recovered.events.map((event) => event.cursor)).toEqual(recovered.events.map((_, index) => index + 1))
  })
})
