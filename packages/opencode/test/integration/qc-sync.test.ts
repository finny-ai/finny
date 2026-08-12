import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import {
  attachProject,
  getProjectLink,
  localSourceFilesForAlgorithm,
  refreshLinkSync,
  resolveDrift,
  syncBeforeRun,
  unlinkProject,
} from "../../src/integration/qc-sync"
import { sha256Text } from "../../src/integration/qc-contracts"
import { writeLeanSourceFile } from "../../src/backtest/lean/source-store"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const cleanups: string[] = []
let originalFetch: typeof fetch

function isolatedHome(): string {
  const home = `/tmp/finny-qc-sync-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_CONTROL_DIR = path.join(home, "qc-control")
  cleanups.push(home)
  return home
}

import path from "node:path"

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  if (originalFetch) globalThis.fetch = originalFetch
  delete process.env.FINNY_QC_CONTROL_DIR
})

function mockCloudQc(input: {
  projectId: number
  language: string
  files: Array<{ name: string; content: string }>
}) {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (fetchInput: RequestInfo | URL, init?: RequestInit) => {
    const apiPath = new URL(String(fetchInput)).pathname.replace(/\/api\/v2$/, "").replace(/\/api\/v2\//, "/")
    if (apiPath === "/files/read") {
      return new Response(
        JSON.stringify({
          success: true,
          files: input.files.map((file) => ({ name: file.name, content: file.content })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (apiPath === "/projects/read") {
      return new Response(
        JSON.stringify({
          success: true,
          projects: [
            {
              projectId: input.projectId,
              organizationId: "org-1",
              name: "Project",
              language: input.language,
              ownerId: 1,
              modified: "2026-08-08T00:00:00Z",
              created: "2026-08-01T00:00:00Z",
              leanVersionId: 17202,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    throw new Error(`unexpected QC API path ${apiPath}`)
  }) as unknown as typeof fetch
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    quantconnect: { type: "api", key: "qc-token", metadata: { userId: "1001200" } },
  })
}

function algorithm() {
  return {
    algorithmId: "11111111-1111-4111-8111-111111111111",
    userId: "u",
    name: "sync-algo",
    code: "class Main(QCAlgorithm):\n    def Initialize(self): pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({
      symbol: "SPY",
      asset_class: "equity",
      interval: "5m",
      runtime: { profile: { profileId: "qc_cloud" } },
    }),
    time_created: 0,
    time_updated: 0,
  }
}

describe("QC project linking (fixture mode)", () => {
  test("attach links and reports in_sync for an empty local tree", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    const result = await attachProject({ algorithm: algo, projectId: 24058693, projectName: "Fixture", language: "python" })
    expect(result.link.sync.state).toBe("in_sync")
    const link = await getProjectLink(algo.algorithmId)
    expect(link?.projectId).toBe(24058693)
    expect(link?.language).toBe("python")
  })

  test("fixture syncBeforeRun passes once linked", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    await attachProject({ algorithm: algo, projectId: 24058693, language: "python" })
    const decision = await syncBeforeRun(algo)
    expect(decision.ok).toBe(true)
    expect(decision.action).toBe("in_sync")
  })

  test("syncBeforeRun fails closed when unlinked", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const decision = await syncBeforeRun(algorithm())
    expect(decision.ok).toBe(false)
  })

  test("local source changes become finny_changed drift", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    await attachProject({ algorithm: algo, projectId: 24058693, language: "python" })
    await writeLeanSourceFile({
      algorithm: algo,
      relativePath: "main.py",
      content: "class Main(QCAlgorithm):\n    def Initialize(self):\n        self.SetCash(20000)\n",
    })
    const decision = await refreshLinkSync(algo)
    expect(decision.ok).toBe(false)
    expect(decision.action).toBe("push_finny")
  })

  test("resolveDrift import_qc re-adopts the remote tree and re-syncs", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    await attachProject({ algorithm: algo, projectId: 24058693, language: "python" })
    await writeLeanSourceFile({ algorithm: algo, relativePath: "main.py", content: "local-edit" })
    const decision = await resolveDrift({ algorithm: algo, direction: "import_qc" })
    expect(decision.ok).toBe(true)
    const link = await getProjectLink(algo.algorithmId)
    expect(link?.sync.state).toBe("in_sync")
  })

  test("unlink removes the binding", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const algo = algorithm()
    await attachProject({ algorithm: algo, projectId: 24058693, language: "python" })
    expect(await unlinkProject(algo.algorithmId)).toBe(true)
    expect(await getProjectLink(algo.algorithmId)).toBeNull()
  })

  test("localSourceFilesForAlgorithm falls back to algorithm.code", async () => {
    isolatedHome()
    const files = await localSourceFilesForAlgorithm(algorithm())
    expect(files.length).toBe(1)
    expect(files[0]!.path).toBe("main.py")
    expect(files[0]!.sha256).toBe(sha256Text(algorithm().code))
  })
})

describe("QC project linking (cloud mode)", () => {
  test("links a C# project without an explicit language and resolves it from QC", async () => {
    isolatedHome()
    mockCloudQc({
      projectId: 24058695,
      language: "C#",
      files: [{ name: "Main.cs", content: "class Main : QCAlgorithm { }\n" }],
    })
    const algo = algorithm()
    const result = await attachProject({ algorithm: algo, projectId: 24058695, projectName: "CSharp Project" })
    expect(result.link.language).toBe("csharp")
    expect(result.link.sync.state).toBe("both_changed")
    expect(result.imported).toBe(false)
  })

  test("drift from an unsynchronized link is not masked by the first refresh", async () => {
    isolatedHome()
    mockCloudQc({
      projectId: 24058696,
      language: "Py",
      files: [{ name: "main.py", content: "class Main(QCAlgorithm):\n    def Initialize(self):\n        self.SetCash(50000)\n" }],
    })
    const algo = algorithm()
    // Local tree differs from the remote tree (fallback main.py content).
    const result = await attachProject({ algorithm: algo, projectId: 24058696, projectName: "Drift Project" })
    expect(result.link.sync.state).toBe("both_changed")

    const refreshed = await refreshLinkSync(algo)
    // The first refresh must keep reporting the drift instead of claiming
    // in_sync just because both sides were recorded as "the sync point".
    expect(refreshed.ok).toBe(false)
    expect(refreshed.action).toBe("blocked")
    const link = await getProjectLink(algo.algorithmId)
    expect(link?.sync.state).toBe("both_changed")
  })

  test("import_remote adopts the QC tree, language, and records in_sync", async () => {
    isolatedHome()
    mockCloudQc({
      projectId: 24058697,
      language: "C#",
      files: [{ name: "Main.cs", content: "class Main : QCAlgorithm { }\n" }],
    })
    const algo = algorithm()
    const result = await attachProject({
      algorithm: algo,
      projectId: 24058697,
      projectName: "Import Project",
      mode: "import_remote",
    })
    expect(result.imported).toBe(true)
    expect(result.link.language).toBe("csharp")
    expect(result.link.sync.state).toBe("in_sync")
    const local = await localSourceFilesForAlgorithm(algo)
    expect(local.some((file) => file.path === "Main.cs")).toBe(true)

    const refreshed = await refreshLinkSync(algo)
    expect(refreshed.ok).toBe(true)
    expect(refreshed.action).toBe("in_sync")
  })
})
