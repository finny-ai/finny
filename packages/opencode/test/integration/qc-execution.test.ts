import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as QcExecution from "../../src/integration/qc-execution"
import { listDeployments, upsertDeployment, appendDeploymentLog, listDeploymentLogs } from "../../src/integration/qc-store"
import { startPaperDeployment, stopDeployment, liquidateDeployment, rehydrate } from "../../src/integration/qc-execution"

const originalFinnyHome = process.env.FINNY_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalFixture = process.env.QC_FIXTURE
const originalControl = process.env.FINNY_QC_CONTROL_DIR
const originalLegacy = process.env.FINNY_QC_LEGACY_FILE
const cleanups: string[] = []

function isolatedHome(): string {
  const home = `/tmp/finny-qc-exec-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = home
  process.env.XDG_DATA_HOME = home
  process.env.FINNY_QC_CONTROL_DIR = path.join(home, "qc-control")
  cleanups.push(home)
  return home
}

afterEach(async () => {
  QcExecution.stopPolling()
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalFixture === undefined) delete process.env.QC_FIXTURE
  else process.env.QC_FIXTURE = originalFixture
  if (originalControl === undefined) delete process.env.FINNY_QC_CONTROL_DIR
  else process.env.FINNY_QC_CONTROL_DIR = originalControl
  if (originalLegacy === undefined) delete process.env.FINNY_QC_LEGACY_FILE
  else process.env.FINNY_QC_LEGACY_FILE = originalLegacy
})

function record(overrides: Partial<Parameters<typeof upsertDeployment>[0]> = {}) {
  return {
    schema: "finny.qc_deployment" as const,
    version: 1 as const,
    deploymentId: overrides.deploymentId ?? "qc-deploy-test-1",
    algorithmId: "algo-1",
    algorithmName: "test-algo",
    algorithmVersion: 1,
    runId: "run-1",
    runIdentityHash: "a".repeat(64),
    sourceTreeHash: "b".repeat(64),
    projectId: 42,
    projectName: "Test project",
    environment: "qc_paper" as const,
    brokerKind: "qc_paper" as const,
    capital: 10000,
    status: "running" as const,
    ownership: "managed" as const,
    qcStatus: "Running",
    liveUrl: "https://www.quantconnect.com/project/42",
    startedAt: Date.now(),
    mode: "fixture" as const,
    ...overrides,
  }
}

describe("QC execution manager", () => {
  test("rehydrates records into run views with QC detail", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    await upsertDeployment(record())
    const runs = await rehydrate()
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.backend).toBe("qc")
    expect(run.brokerKind).toBe("qc")
    expect(run.qc.deploymentId).toBe("qc-deploy-test-1")
    expect(run.qc.projectId).toBe(42)
    expect(run.qc.ownership).toBe("managed")
    expect(run.mode).toBe("paper")
  })

  test("fixture deployments stay running and stop cleanly", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    await upsertDeployment(record())
    await rehydrate()
    await QcExecution.reconcileManaged()
    expect((await listDeployments())[0]!.status).toBe("running")
    const stopped = await stopDeployment("qc-deploy-test-1")
    expect(stopped.ok).toBe(true)
    expect((await listDeployments())[0]!.status).toBe("stopped")
  })

  test("liquidate stops the fixture deployment", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    await upsertDeployment(record())
    await rehydrate()
    const result = await liquidateDeployment("qc-deploy-test-1")
    expect(result.ok).toBe(true)
    expect((await listDeployments())[0]!.qcStatus).toBe("Liquidated")
  })

  test("deployment logs are append-only and durable", async () => {
    isolatedHome()
    await appendDeploymentLog("qc-deploy-test-1", { level: "info", message: "first" })
    await appendDeploymentLog("qc-deploy-test-1", { level: "error", message: "second" })
    const logs = await listDeploymentLogs("qc-deploy-test-1")
    expect(logs).toHaveLength(2)
    expect(logs[0]!.message).toBe("first")
    expect(logs[1]!.level).toBe("error")
  })

  test("startPaperDeployment fails closed without a valid paper approval", async () => {
    isolatedHome()
    process.env.QC_FIXTURE = "1"
    const result = await startPaperDeployment({
      algorithm: {
        algorithmId: "11111111-1111-4111-8111-111111111111",
        userId: "u",
        name: "no-approval",
        code: "class Main(QCAlgorithm): pass",
        language: "python",
        version: 1,
        status: "draft",
        time_created: 0,
        time_updated: 0,
      } as never,
      runId: "run-missing",
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Paper approval is not valid")
  })

  test("imports the legacy deployment ledger once", async () => {
    isolatedHome()
    const legacy = path.join(process.env.FINNY_HOME!, "legacy-qc-paper-deployments.json")
    process.env.FINNY_QC_LEGACY_FILE = legacy
    await fs.mkdir(process.env.FINNY_HOME!, { recursive: true })
    await fs.writeFile(
      legacy,
      JSON.stringify([
        {
          deploymentId: "L-legacy-1",
          algorithmName: "legacy",
          algorithmVersion: 1,
          projectId: 7,
          status: "running",
          mode: "cloud",
          startedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
    )
    const deployments = await listDeployments()
    expect(deployments).toHaveLength(1)
    expect(deployments[0]!.deploymentId).toBe("L-legacy-1")
    expect(deployments[0]!.ownership).toBe("managed")
    expect(deployments[0]!.status).toBe("running")
  })
})
