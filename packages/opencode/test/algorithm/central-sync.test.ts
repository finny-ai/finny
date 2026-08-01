import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Algorithm } from "../../src/algorithm"
import { CentralSync, type Transport } from "../../src/algorithm/central-sync"
import { DeviceProfile } from "../../src/device"
import { LocalAlgorithmStore } from "../../src/storage/local/algorithm-store"
import { BacktestStore } from "../../src/backtest/store"
import { AlgorithmVersionPackage } from "../../src/algorithm/version-package"

let sandbox: string
let savedEnv: NodeJS.ProcessEnv

async function fixture() {
  return LocalAlgorithmStore.insertVersion({
    algorithmId: "sync-algorithm",
    userId: "device-owner-must-not-leak",
    name: "sync-name",
    code: "class Strategy:\n    pass\n",
    language: "python",
    status: "draft",
    config: "{}\n",
    reasoning: "reason\n",
    mission: "mission\n",
    prefs: "prefs\n",
    decisions: "decision\n",
    riskContract: "{}\n",
    docsMode: "replace",
    brokerKind: "ibkr",
    targetBrokerage: "binance",
    time_created: 1,
    time_updated: 2,
  }) as Promise<Algorithm.Info>
}

function backtestManifest(id: string, sourceArtifacts?: string): BacktestStore.Manifest {
  return {
    id,
    source: "run",
    algorithmId: "sync-algorithm",
    algorithmName: "sync-name",
    algorithmVersion: 1,
    params: { duration: "1y", interval: "1d", capital: "10000" },
    assumptions: { feeBps: 1, slippageBps: 2, fillModel: "next_open" },
    results: {
      totalReturn: 1,
      maxDrawdown: 2,
      annualizedVolatility: 3,
      sharpeRatio: 4,
      endingEquity: 10100,
      totalTrades: 5,
      winRate: 60,
      profitFactor: 1.2,
      ...(sourceArtifacts ? { runKind: "crucible_2_0" as const } : {}),
    },
    benchmark: null,
    alpha: null,
    artifacts: { equityCurve: null, trades: null, sourceArtifacts: sourceArtifacts ?? null },
    timestamp: 123,
  }
}

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-central-sync-"))
  process.env.FINNY_HOME = path.join(sandbox, "home")
  process.env.FINNY_PLATFORM_SYNC_MODE = "off"
  DeviceProfile._setStateDirForTests(path.join(sandbox, "device"))
})

afterEach(async () => {
  CentralSync._setTransportForTests()
  DeviceProfile._resetForTests()
  process.env = savedEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe.serial("central publication outbox", () => {
  test("writes the deterministic outbox before POST and omits device ownership", async () => {
    const algorithm = await fixture()
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    process.env.FINNY_MAIN_SESSION_ID = "session-from-runner-env"
    process.env.OMNIGENT_SESSION_ID = "session-from-omnigent"
    let calls = 0
    CentralSync._setTransportForTests({
      async publishVersion({ publication }) {
        calls++
        expect((await CentralSync.pendingOutbox()).length).toBe(1)
        expect(JSON.stringify(publication)).not.toContain("device-owner-must-not-leak")
        expect(publication.sourceSessionId).toBe("session-from-omnigent")
        expect(publication.algorithm.brokerKind).toBe("ibkr")
        expect(publication.algorithm.targetBrokerage).toBe("binance")
      },
      async publishBacktest() {},
    })

    expect(await CentralSync.publishAlgorithmVersion(algorithm)).toBe("published")
    expect(calls).toBe(1)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })

  test("keeps failures retryable and reports retry status", async () => {
    const algorithm = await fixture()
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    CentralSync._setTransportForTests({
      async publishVersion() {
        throw new Error("offline")
      },
      async publishBacktest() {
        throw new Error("offline")
      },
    })

    await expect(CentralSync.publishAlgorithmVersion(algorithm)).rejects.toBeInstanceOf(CentralSync.PublishError)
    expect((await CentralSync.pendingOutbox()).length).toBe(1)

    let retried = 0
    CentralSync._setTransportForTests({
      async publishVersion() {
        retried++
      },
      async publishBacktest() {},
    })
    expect(await CentralSync.retryOutbox()).toEqual({ published: 1, failed: 0 })
    expect(retried).toBe(1)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })

  test("retries version publications before backtests", async () => {
    const algorithm = await fixture()
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    CentralSync._setTransportForTests({
      async publishVersion() {
        throw new Error("offline")
      },
      async publishBacktest() {
        throw new Error("offline")
      },
    })
    await expect(CentralSync.publishBacktestSummary(backtestManifest("retry-order"))).rejects.toBeInstanceOf(
      CentralSync.PublishError,
    )
    await expect(CentralSync.publishAlgorithmVersion(algorithm)).rejects.toBeInstanceOf(CentralSync.PublishError)

    const order: string[] = []
    CentralSync._setTransportForTests({
      async publishVersion() {
        order.push("version")
      },
      async publishBacktest() {
        order.push("backtest")
      },
    })
    expect(await CentralSync.retryOutbox()).toEqual({ published: 2, failed: 0 })
    expect(order).toEqual(["version", "backtest"])
  })

  test("replays the first durable event for an idempotent version retry", async () => {
    const algorithm = await fixture()
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    CentralSync._setTransportForTests({
      async publishVersion() {
        throw new Error("offline")
      },
      async publishBacktest() {},
    })
    await expect(CentralSync.publishAlgorithmVersion(algorithm)).rejects.toBeInstanceOf(CentralSync.PublishError)

    let publishedTime: number | undefined
    CentralSync._setTransportForTests({
      async publishVersion({ publication }) {
        publishedTime = publication.algorithm.timeUpdated
      },
      async publishBacktest() {},
    })
    expect(await CentralSync.publishAlgorithmVersion({ ...algorithm, time_updated: 999 })).toBe("published")
    expect(publishedTime).toBe(algorithm.time_updated)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })

  test("required save fails centrally after the local version is durable", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    CentralSync._setTransportForTests({
      async publishVersion() {
        throw new Error("platform unavailable")
      },
      async publishBacktest() {},
    })

    await expect(
      Algorithm.save({ name: "required-save", code: "class Strategy:\n    pass\n", saveMode: "new" }),
    ).rejects.toBeInstanceOf(CentralSync.PublishError)
    expect((await LocalAlgorithmStore.listByUser(await DeviceProfile.userId())).map((row) => row.name)).toContain(
      "required-save",
    )
    expect((await CentralSync.pendingOutbox()).length).toBe(1)
  })

  test("times out required publication with its outbox already durable", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    process.env.FINNY_PLATFORM_URL = "https://platform.example"
    process.env.FINNY_PLATFORM_ACCESS_TOKEN = "runner-token"
    process.env.FINNY_PLATFORM_HTTP_TIMEOUT_MS = "10"
    process.env.OMNIGENT_SESSION_ID = "timeout-session"
    CentralSync._setTransportForTests()
    const originalFetch = globalThis.fetch
    let outboxBeforeFetch = 0
    globalThis.fetch = (async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      outboxBeforeFetch = (await CentralSync.pendingOutbox()).length
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        )
      })
    }) as unknown as typeof fetch
    try {
      await expect(
        Algorithm.save({ name: "timeout-save", code: "class Strategy:\n    pass\n", saveMode: "new" }),
      ).rejects.toBeInstanceOf(CentralSync.PublishError)
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(outboxBeforeFetch).toBe(1)
    expect((await CentralSync.pendingOutbox()).length).toBe(1)
    expect((await LocalAlgorithmStore.listByUser(await DeviceProfile.userId())).map((row) => row.name)).toContain(
      "timeout-save",
    )
  })

  test("downloads and identity-materializes an exact version into a fresh sandbox", async () => {
    const source = await fixture()
    const packaged = await AlgorithmVersionPackage.build({ algorithmId: source.algorithmId, version: source.version })
    process.env.FINNY_HOME = path.join(sandbox, "restored-home")
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest() {},
      async downloadVersion(input) {
        expect(input).toEqual({ algorithmId: source.algorithmId, version: source.version })
        return {
          catalog: {
            algorithmId: source.algorithmId,
            name: source.name,
            version: source.version,
            language: source.language,
            status: source.status,
            description: source.description,
            brokerKind: source.brokerKind,
            targetBrokerage: source.targetBrokerage,
            timeCreated: source.time_created,
            timeUpdated: source.time_updated,
          },
          bundle: packaged.archive,
        }
      },
    })

    const restored = await CentralSync.materializeVersion({ algorithmId: source.algorithmId, version: source.version })
    expect(restored.algorithmId).toBe(source.algorithmId)
    expect(restored.version).toBe(source.version)
    expect(restored.userId).toBe(await DeviceProfile.userId())
    expect(await fs.readFile(path.join(LocalAlgorithmStore.directoryFor(source.algorithmId), "CURRENT"), "utf8")).toBe(
      "v01",
    )
  })

  test("default download sends source-session authority on detail and bundle GETs", async () => {
    const source = await fixture()
    const packaged = await AlgorithmVersionPackage.build({ algorithmId: source.algorithmId, version: source.version })
    process.env.FINNY_HOME = path.join(sandbox, "default-transport-restore")
    process.env.OMNIGENT_POLICY_URL = "https://platform.example"
    process.env.OMNIGENT_POLICY_AUTH = "Bearer runner-token"
    process.env.FINNY_MAIN_SESSION_ID = "fallback-source-session"
    process.env.OMNIGENT_SESSION_ID = "verified-source-session"
    CentralSync._setTransportForTests()
    const requests: Array<{ url: string; headers: Headers }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.endsWith("/bundle")) return new Response(Buffer.from(packaged.archive))
      return Response.json({
        algorithm: {
          algorithmId: source.algorithmId,
          name: source.name,
          version: source.version,
          language: source.language,
          status: source.status,
          timeCreated: source.time_created,
          timeUpdated: source.time_updated,
        },
      })
    }) as unknown as typeof fetch
    try {
      await CentralSync.materializeVersion({ algorithmId: source.algorithmId, version: source.version })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(requests.map((request) => request.url)).toEqual([
      "https://platform.example/api/finny/algorithms/sync-algorithm/versions/1",
      "https://platform.example/api/finny/algorithms/sync-algorithm/versions/1/bundle",
    ])
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer runner-token")
      expect(request.headers.get("x-finny-source-session-id")).toBe("verified-source-session")
    }
  })

  test("download timeout also bounds a hanging response body", async () => {
    process.env.FINNY_PLATFORM_URL = "https://platform.example"
    process.env.FINNY_PLATFORM_ACCESS_TOKEN = "runner-token"
    process.env.OMNIGENT_SESSION_ID = "verified-source-session"
    process.env.FINNY_PLATFORM_HTTP_TIMEOUT_MS = "10"
    CentralSync._setTransportForTests()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    try {
      await expect(
        CentralSync.materializeVersion({ algorithmId: "sync-algorithm", version: 1 }),
      ).rejects.toBeInstanceOf(CentralSync.TransportTimeoutError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects malformed Omnigent policy authorization", async () => {
    process.env.OMNIGENT_POLICY_URL = "https://platform.example"
    process.env.OMNIGENT_POLICY_AUTH = "Basic not-a-runner-token"
    process.env.OMNIGENT_SESSION_ID = "verified-source-session"
    delete process.env.FINNY_PLATFORM_URL
    delete process.env.FINNY_PLATFORM_ACCESS_TOKEN
    CentralSync._setTransportForTests()
    await expect(CentralSync.materializeVersion({ algorithmId: "sync-algorithm", version: 1 })).rejects.toThrow(
      "valid Bearer token",
    )
  })

  test("BacktestStore.save leaves local evidence durable but propagates required publication failure", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    process.env.FINNY_MAIN_SESSION_ID = "backtest-session-from-env"
    let received: Parameters<Transport["publishBacktest"]>[0] | undefined
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest(input) {
        received = input
        throw new Error("platform unavailable")
      },
    })
    const id = `central-hook-${crypto.randomUUID()}`
    const save = BacktestStore.save({
      record: {
        id,
        source: "run",
        algorithmId: "backtest-algorithm",
        algorithmName: `central-hook-${id}`,
        algorithmVersion: 7,
        params: { duration: "1y", interval: "1d", capital: "10000" },
        assumptions: { feeBps: 1, slippageBps: 2, fillModel: "next_open" },
        results: {
          totalReturn: 1,
          maxDrawdown: 2,
          annualizedVolatility: 3,
          sharpeRatio: 4,
          endingEquity: 10100,
          totalTrades: 5,
          winRate: 60,
          profitFactor: 1.2,
        },
        benchmark: null,
        alpha: null,
        timestamp: 123,
      },
    })
    await expect(save).rejects.toBeInstanceOf(CentralSync.PublishError)
    expect(received?.publication.schema).toBe("finny.backtest_publication")
    expect(received?.publication.sourceSessionId).toBe("backtest-session-from-env")
    expect(received?.publication.run.status).toBe("completed")
    expect((await CentralSync.pendingOutbox()).length).toBe(1)
    const localDir = path.join(BacktestStore.rootDir(), `central-hook-${id}`, id)
    expect(JSON.parse(await fs.readFile(path.join(localDir, "manifest.json"), "utf8")).id).toBe(id)
    await fs.rm(localDir, { recursive: true, force: true })
  })

  test("BacktestStore.save publishes strict evidence exactly once", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    process.env.FINNY_MAIN_SESSION_ID = "strict-session-from-env"
    const evidenceDir = path.join(sandbox, "strict-run")
    await fs.mkdir(evidenceDir)
    await fs.writeFile(path.join(evidenceDir, "run.json"), "{}\n")
    await fs.writeFile(path.join(evidenceDir, "artifact-manifest.json"), "{}\n")
    let calls = 0
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest(input) {
        calls++
        expect(input.evidence?.length).toBeGreaterThan(0)
        expect(input.publication.run.evidenceAvailable).toBe(true)
        expect(input.publication.sourceSessionId).toBe("strict-session-from-env")
      },
    })
    const id = `strict-hook-${crypto.randomUUID()}`
    const saved = await BacktestStore.save({
      record: {
        id,
        source: "run",
        algorithmId: "strict-algorithm",
        algorithmName: `strict-hook-${id}`,
        algorithmVersion: 3,
        params: { duration: "1y", interval: "1d", capital: "10000" },
        assumptions: { feeBps: 1, slippageBps: 2, fillModel: "next_open" },
        results: {
          totalReturn: 1,
          maxDrawdown: 2,
          annualizedVolatility: 3,
          sharpeRatio: 4,
          endingEquity: 10100,
          totalTrades: 5,
          winRate: 60,
          profitFactor: 1.2,
          runKind: "crucible_2_0",
        },
        benchmark: null,
        alpha: null,
        timestamp: 123,
        artifacts: { sourceArtifacts: evidenceDir },
      },
    })
    expect(calls).toBe(1)
    expect(await CentralSync.pendingOutbox()).toEqual([])
    await fs.rm(saved.dir, { recursive: true, force: true })
  })

  test("rejects incomplete strict evidence before transport or outbox delivery", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    const evidenceDir = path.join(sandbox, "incomplete-strict-run")
    await fs.mkdir(evidenceDir)
    await fs.writeFile(path.join(evidenceDir, "run.json"), "{}\n")
    let calls = 0
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest() {
        calls++
      },
    })
    await expect(
      CentralSync.publishStrictRun({
        dir: evidenceDir,
        manifest: {
          id: "incomplete-strict",
          source: "run",
          algorithmId: "strict-algorithm",
          algorithmName: "strict-name",
          algorithmVersion: 3,
          params: { duration: "1y", interval: "1d", capital: "10000" },
          assumptions: { feeBps: 1, slippageBps: 2, fillModel: "next_open" },
          results: {
            totalReturn: 1,
            maxDrawdown: 2,
            annualizedVolatility: 3,
            sharpeRatio: 4,
            endingEquity: 10100,
            totalTrades: 5,
            winRate: 60,
            profitFactor: 1.2,
            runKind: "crucible_2_0",
          },
          benchmark: null,
          alpha: null,
          artifacts: { equityCurve: null, trades: null, sourceArtifacts: evidenceDir },
          timestamp: 123,
        },
      }),
    ).rejects.toBeInstanceOf(CentralSync.PreflightError)
    expect(calls).toBe(0)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })

  test("rejects strict evidence when ZIP overhead exceeds the upload limit", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    process.env.FINNY_BACKTEST_EVIDENCE_MAX_BYTES = "32"
    const evidenceDir = path.join(sandbox, "zip-overhead-strict-run")
    await fs.mkdir(evidenceDir)
    await fs.writeFile(path.join(evidenceDir, "run.json"), "{}")
    await fs.writeFile(path.join(evidenceDir, "artifact-manifest.json"), "{}")
    let calls = 0
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest() {
        calls++
      },
    })

    await expect(
      CentralSync.publishStrictRun({
        dir: evidenceDir,
        manifest: backtestManifest("zip-overhead-strict", evidenceDir),
      }),
    ).rejects.toBeInstanceOf(CentralSync.PreflightError)
    expect(calls).toBe(0)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })

  test("rejects unsafe and oversized strict evidence before reads or delivery", async () => {
    process.env.FINNY_PLATFORM_SYNC_MODE = "required"
    let calls = 0
    CentralSync._setTransportForTests({
      async publishVersion() {},
      async publishBacktest() {
        calls++
      },
    })

    const unsafeDir = path.join(sandbox, "unsafe-strict")
    await fs.mkdir(unsafeDir)
    await fs.writeFile(path.join(unsafeDir, "run.json"), "{}")
    await fs.writeFile(path.join(unsafeDir, "artifact-manifest.json"), "{}")
    await fs.writeFile(path.join(unsafeDir, "unsafe\\name"), "x")
    await expect(
      CentralSync.publishStrictRun({ manifest: backtestManifest("unsafe", unsafeDir), dir: unsafeDir }),
    ).rejects.toBeInstanceOf(CentralSync.PreflightError)

    const oversizedDir = path.join(sandbox, "oversized-strict")
    await fs.mkdir(oversizedDir)
    await fs.writeFile(path.join(oversizedDir, "run.json"), "{}")
    await fs.writeFile(path.join(oversizedDir, "artifact-manifest.json"), "{}")
    await fs.writeFile(path.join(oversizedDir, "extra.json"), "{}")
    process.env.FINNY_BACKTEST_EVIDENCE_MAX_BYTES = "5"
    await expect(
      CentralSync.publishStrictRun({ manifest: backtestManifest("oversized", oversizedDir), dir: oversizedDir }),
    ).rejects.toBeInstanceOf(CentralSync.PreflightError)
    expect(calls).toBe(0)
    expect(await CentralSync.pendingOutbox()).toEqual([])
  })
})
