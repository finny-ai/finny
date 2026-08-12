import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { evaluateCloudGates } from "../../src/integration/qc-composite"
import { qcPushLanguage } from "../../src/integration/qc-cloud"
import {
  attachProject,
  getProjectLink,
  refreshLinkSync,
  resolveDrift,
} from "../../src/integration/qc-sync"
import { loadSourceSnapshot, saveSourceSnapshot } from "../../src/integration/qc-store"
import { writeLeanSourceFile } from "../../src/backtest/lean/source-store"
import { runtimeProfileV1, sha256Text } from "../../src/backtest/lean/contracts"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalControl = process.env.FINNY_QC_CONTROL_DIR
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-qc-review-fixes-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_CONTROL_DIR = path.join(home, "qc-control")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
  if (originalControl === undefined) delete process.env.FINNY_QC_CONTROL_DIR
  else process.env.FINNY_QC_CONTROL_DIR = originalControl
})

function algorithm(overrides: Record<string, unknown> = {}) {
  return {
    algorithmId: "22222222-2222-4222-8222-222222222222",
    userId: "u",
    name: "review-fixes-algo",
    code: "class Main(QCAlgorithm):\n    def Initialize(self): pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({
      symbol: "SPY",
      asset_class: "equity",
      interval: "5m",
      runtime: { profile: runtimeProfileV1("qc_cloud") },
    }),
    time_created: 0,
    time_updated: 0,
    ...overrides,
  }
}

describe("QC cloud composite gates", () => {
  test("the drawdown gate caps the magnitude of a negative drawdown", () => {
    // canonical.max_drawdown is negative; a 90% drawdown must FAIL a 50% cap
    // and a 20% drawdown must pass — the pre-fix comparison always passed.
    const deep = evaluateCloudGates({ max_drawdown: -0.9, total_return: 0.1, total_trades: 10, raw: {} })
    expect(deep.passed).toBe(false)
    expect(deep.checks.find((check) => check.name === "max_drawdown")?.passed).toBe(false)

    const shallow = evaluateCloudGates({ max_drawdown: -0.2, total_return: 0.1, total_trades: 10, raw: {} })
    expect(shallow.passed).toBe(true)
  })
})

describe("QC push language resolution", () => {
  test("a lean_csharp runtime profile pushes a C# project and Main.cs", () => {
    const algo = algorithm({
      language: "python",
      config: JSON.stringify({
        symbol: "SPY",
        asset_class: "equity",
        interval: "5m",
        runtime: { profile: runtimeProfileV1("lean_csharp") },
      }),
    })
    expect(qcPushLanguage(algo)).toBe("csharp")
  })

  test("a legacy csharp algorithm (no runtime) pushes C#", () => {
    const algo = algorithm({ language: "csharp", config: "{}" })
    expect(qcPushLanguage(algo)).toBe("csharp")
  })

  test("a python runtime pushes a Python project", () => {
    const algo = algorithm({
      config: JSON.stringify({
        symbol: "SPY",
        asset_class: "equity",
        interval: "5m",
        runtime: { profile: runtimeProfileV1("lean_python") },
      }),
    })
    expect(qcPushLanguage(algo)).toBe("python")
  })
})

describe("QC sync drift persistence", () => {
  test("drift stays visible across repeated refreshes until explicitly resolved", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    await attachProject({ algorithm: algo, projectId: 24058693, language: "python" })
    await writeLeanSourceFile({
      algorithm: algo,
      relativePath: "main.py",
      content: "class Main(QCAlgorithm):\n    def Initialize(self):\n        self.SetCash(20000)\n",
    })

    const first = await refreshLinkSync(algo)
    expect(first.ok).toBe(false)
    expect(first.action).toBe("push_finny")

    // The pre-fix refresh overwrote the synced hashes, so a second refresh
    // reported in_sync and let backtests/deploys run against drifted source.
    const second = await refreshLinkSync(algo)
    expect(second.ok).toBe(false)
    expect(second.action).toBe("push_finny")

    const resolved = await resolveDrift({ algorithm: algo, direction: "push_finny" })
    expect(resolved.ok).toBe(true)
    const link = await getProjectLink(algo.algorithmId)
    expect(link?.sync.state).toBe("in_sync")
  })
})

describe("QC source snapshots", () => {
  test("non-conforming algorithm ids never share a snapshot directory", async () => {
    isolatedHome()
    const content = (body: string) => ({ path: "main.py", sha256: sha256Text(body), bytes: Buffer.byteLength(body) })
    await saveSourceSnapshot({
      schema: "finny.qc_source_snapshot",
      version: 1,
      algorithmId: "algo-one!",
      algorithmVersion: 1,
      profileId: "qc_cloud",
      files: [content("first")],
      sourceTreeHash: "a".repeat(64),
    })
    await saveSourceSnapshot({
      schema: "finny.qc_source_snapshot",
      version: 1,
      algorithmId: "algo-two!",
      algorithmVersion: 1,
      profileId: "qc_cloud",
      files: [content("second")],
      sourceTreeHash: "b".repeat(64),
    })
    const first = await loadSourceSnapshot("algo-one!", 1)
    const second = await loadSourceSnapshot("algo-two!", 1)
    expect(first?.files[0]?.sha256).toBe(sha256Text("first"))
    expect(second?.files[0]?.sha256).toBe(sha256Text("second"))
    expect(first?.files[0]?.sha256).not.toBe(second?.files[0]?.sha256)
  })
})
