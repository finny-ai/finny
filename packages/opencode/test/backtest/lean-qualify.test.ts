import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { compileExperimentPlanV2 } from "../../src/backtest/experiment-plan"
import {
  loadExperimentPlanV2,
  readHoldoutOpenEventsV1,
  recordHoldoutOpenEventForPlanV2,
  saveExperimentPlanV2,
} from "../../src/backtest/experiment-plan-store"
import { DEFAULT_QUALIFICATION_POLICY_V1 } from "../../src/backtest/qualification-policy"
import { LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST } from "../../src/backtest/lean/contracts"
import { executeLeanQualificationV2 } from "../../src/backtest/lean/qualify"
import type { LeanAdapterV1 } from "../../src/backtest/lean/runner"
import type { Algorithm } from "../../src/algorithm"

const originalHome = process.env.FINNY_HOME
const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalHome
})

function tmpHome() {
  const dir = `/tmp/finny-lean-qualify-test-${Math.random().toString(36).slice(2)}`
  process.env.FINNY_HOME = dir
  cleanups.push(dir)
  fs.mkdir(dir, { recursive: true })
  return dir
}

function plan() {
  return compileExperimentPlanV2({
    request: {
      requestId: "req-lean",
      requestVersion: 1,
      requestHash: "a".repeat(64),
      interval: "1h",
      requestedStart: "2026-01-01",
      requestedEnd: "2026-01-31",
    },
    candidate: {
      candidateId: "01234567-89ab-cdef-0123-456789abcdef",
      codeHash: "c".repeat(64),
      configHash: "d".repeat(64),
      warmupBars: 1,
      declaredSearchBudget: 1,
    },
    runtime: {
      profileId: "lean_python",
      profileHash: "ab".repeat(32),
      sourceTreeHash: "cd".repeat(32),
      adapterHash: "ef".repeat(32),
      executionProfileHash: "12".repeat(32),
      imageDigest: LEAN_PINNED_IMAGE_DIGEST,
      leanCommit: LEAN_PINNED_COMMIT,
      leanConfigHash: "34".repeat(32),
    },
    datasets: [
      {
        canonicalSymbol: "SPY",
        assetClass: "equity",
        datasetEvidenceId: "dataset-1",
        datasetHash: "b".repeat(64),
        manifestHash: "m".repeat(64),
        scheduleHash: "s".repeat(64),
        actualStart: "2026-01-01",
        actualEnd: "2026-01-31",
      },
    ],
    interval: "1h",
    warmupBars: 1,
    declaredSearchBudget: 1,
    calendarPolicyVersion: "finny-calendars-2026.1",
    qualificationPolicy: DEFAULT_QUALIFICATION_POLICY_V1,
    windows: {
      warmup: { start: "2026-01-01", end: "2026-01-01", bars: 1, sessions: 1, firstSessionId: "2026-01-01", lastSessionId: "2026-01-01" },
      exploratory: { start: "2026-01-02", end: "2026-01-10", bars: 50, sessions: 5, firstSessionId: "2026-01-02", lastSessionId: "2026-01-10" },
      validation: { start: "2026-01-11", end: "2026-01-17", bars: 25, sessions: 5, firstSessionId: "2026-01-11", lastSessionId: "2026-01-17" },
      confirmatory: { start: "2026-01-18", end: "2026-01-31", bars: 25, sessions: 5, firstSessionId: "2026-01-18", lastSessionId: "2026-01-31" },
    },
  })
}

describe("LEAN V2 plan store", () => {
  test("persists and reloads V2 plans with holdout events", async () => {
    tmpHome()
    const compiled = plan()
    await saveExperimentPlanV2(compiled, DEFAULT_QUALIFICATION_POLICY_V1)
    const loaded = await loadExperimentPlanV2(compiled.planId)
    expect(loaded.planHash).toBe(compiled.planHash)
    expect(loaded.runtime.profileId).toBe("lean_python")

    await recordHoldoutOpenEventForPlanV2({
      plan: compiled,
      approvalHash: "9".repeat(64),
    })
    const events = await readHoldoutOpenEventsV1(compiled.planId)
    expect(events).toHaveLength(1)
    expect(events[0]?.planId).toBe(compiled.planId)
  })

  test("refuses to persist a tampered V2 plan", async () => {
    tmpHome()
    const compiled = plan()
    await expect(
      saveExperimentPlanV2({ ...compiled, runtime: { ...compiled.runtime, leanCommit: "abc" } }, DEFAULT_QUALIFICATION_POLICY_V1),
    ).rejects.toThrow()
  })
})

describe("LEAN qualification executor", () => {
  function adapterThatFails(): LeanAdapterV1 {
    return {
      profileId: "lean_python",
      probeReady: () => ({ ready: true, reasons: [] }),
      run: async () => ({ ok: false as const, kind: "image_unavailable", error: "pinned image missing" }),
    }
  }

  function candidate(): Algorithm.Info {
    return {
      algorithmId: "01234567-89ab-cdef-0123-456789abcdef",
      userId: "u",
      name: "lean-test",
      code: "class Main(QCAlgorithm): pass",
      language: "python",
      version: 1,
      status: "draft",
      config: JSON.stringify({ symbol: "SPY", asset_class: "equity", interval: "1h", required_history_bars: 1 }),
      time_created: 0,
      time_updated: 0,
    }
  }

  async function realCsv(home: string): Promise<string> {
    const lines = ["timestamp,open,high,low,close,volume"]
    for (let day = 1; day <= 31; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const ts = `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`
        lines.push(`${ts},100,101,99,100.5,1000`)
      }
    }
    const csvPath = `${home}/spy.csv`
    await fs.writeFile(csvPath, lines.join("\n") + "\n", "utf8")
    return csvPath
  }

  test("fails closed on adapter failure with a typed blocker and no fallback", async () => {
    const home = tmpHome()
    const compiled = plan()
    let observedScratch: string | undefined
    let dataTreePresent = false
    await fs.mkdir(`${home}/algorithms/01234567-89ab-cdef-0123-456789abcdef/v01/source`, { recursive: true })
    await fs.writeFile(
      `${home}/algorithms/01234567-89ab-cdef-0123-456789abcdef/v01/source/main.py`,
      "class Main(QCAlgorithm): pass\n",
      "utf8",
    )
    const outcome = await executeLeanQualificationV2({
      candidate: candidate(),
      dataset: {
        csvPath: await realCsv(home),
        csvSha256: "b".repeat(64),
        manifestPath: "/nonexistent.json",
        manifestSha256: "m".repeat(64),
        identity: {
          actualSymbol: "SPY",
          actualAssetClass: "equity",
          actualInterval: "1h",
          actualStart: "2026-01-01",
          actualEnd: "2026-01-31",
        } as any,
        qualificationAttestation: undefined,
      } as any,
      plan: compiled,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
      executionIdentity: { codeHash: "c".repeat(64), configHash: "d".repeat(64) },
      adapter: {
        profileId: "lean_python",
        probeReady: () => ({ ready: true, reasons: [] }),
        run: async (input) => {
          observedScratch = input.scratchDir
          dataTreePresent = (await fs.stat(`${input.scratchDir}/equity/usa/hour/spy.zip`).catch(() => null)) !== null
          return { ok: false as const, kind: "image_unavailable", error: "pinned image missing" }
        },
      },
      readHoldoutOpenEvents: () => Promise.resolve([]),
      requestHoldoutApproval: async () => true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.completedPhases).toEqual([])
    expect(outcome.blocker?.code).toBe("quality_gates_failed")
    // The qualification executor must materialize the real LEAN on-disk data
    // tree (not just a bundle manifest) before the adapter is invoked.
    expect(observedScratch).toBeDefined()
    expect(dataTreePresent).toBe(true)
  })
})
