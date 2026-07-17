import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import {
  ensureResearchBrief,
  inspectResearchBrief,
  inspectResearchBriefForBuildHandoff,
  missingResearchBriefFields,
  renderResearchBriefHandoff,
  researchBriefIdentity,
  updateResearchBrief,
  type ResearchBriefContent,
} from "../../src/agent/research-brief"

const identity = researchBriefIdentity({
  request_id: "ses_research",
  requested_symbol: "SPY",
  requested_interval: "15m",
  requested_asset_class: "equity",
  requested_algorithm_name: "spy-15m-mean-reversion",
})

const complete: ResearchBriefContent = {
  hypothesis: "Short-term SPY deviations revert after liquidity shocks.",
  economicRationale: "Temporary order-flow imbalance mean reverts after market makers replenish liquidity.",
  requiredDatasets: ["SPY 15-minute OHLCV", "session calendar"],
  availabilityConstraints: ["Consolidated bars available from 2020 onward"],
  executionAssumptions: {
    fees: "1 bp per side",
    slippage: "2 bps per side",
    spreads: "1 bp during regular hours",
    liquidityAndFills: "marketable limit orders capped at 1% of bar volume",
  },
  temporalLeakageRules: ["Signals use only completed bars", "Corporate actions use point-in-time data"],
  inSamplePlan: "2020-01-01 through 2023-12-31",
  outOfSamplePlan: "2024-01-01 through 2025-12-31, untouched until parameters are frozen",
  falsificationCriteria: ["OOS Sharpe below 0.5", "Costs erase the gross edge"],
  minimumEvidence: ["At least 100 OOS trades", "Positive net expectancy after stated costs"],
  unresolvedQuestions: [],
}

async function workspace() {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "request.json"), JSON.stringify(identityToRequest(identity)))
  return tmp
}

function identityToRequest(value: typeof identity) {
  return {
    request_id: value.request_id,
    requested_symbol: value.requested_symbol,
    requested_symbols: value.requested_symbols,
    requested_interval: value.requested_interval,
    requested_asset_class: value.requested_asset_class,
    requested_algorithm_name: value.requested_algorithm_name,
  }
}

describe("ResearchBrief", () => {
  test("persists an explicitly incomplete versioned draft", async () => {
    await using tmp = await workspace()
    const brief = await ensureResearchBrief(tmp.path, identity, new Date("2026-07-10T12:00:00Z"))
    const status = await inspectResearchBrief(tmp.path)

    expect(brief.schema_version).toBe(1)
    expect(brief.transition).toBe("draft")
    expect(brief.revision).toBe(1)
    expect(status.buildReady).toBe(false)
    expect(status.missing).toContain("hypothesis")
    expect(await fs.readFile(path.join(tmp.path, "research-brief.json"), "utf8")).toContain('"schema_version": 1')
  })

  test("requires a complete brief before explicit approval", async () => {
    await using tmp = await workspace()
    await expect(
      updateResearchBrief({
        workspacePath: tmp.path,
        identity,
        content: { hypothesis: "Incomplete" },
        transition: "approved",
      }),
    ).rejects.toThrow("missing required fields")

    const status = await updateResearchBrief({
      workspacePath: tmp.path,
      identity,
      content: complete,
      transition: "approved",
    })
    expect(status.buildReady).toBe(true)
    expect(status.brief?.transition).toBe("approved")
    expect(status.brief?.revision).toBe(2)
  })

  test("user edits reset approval unless the edited revision is explicitly re-approved", async () => {
    await using tmp = await workspace()
    await updateResearchBrief({ workspacePath: tmp.path, identity, content: complete, transition: "approved" })
    const edited = await updateResearchBrief({
      workspacePath: tmp.path,
      identity,
      content: { ...complete, hypothesis: "Edited hypothesis" },
    })

    expect(edited.brief?.transition).toBe("draft")
    expect(edited.buildReady).toBe(false)
    expect(edited.brief?.approved_at).toBeUndefined()
  })

  test("cancellation and stale request identity block Build", async () => {
    await using cancelledTmp = await workspace()
    const cancelled = await updateResearchBrief({
      workspacePath: cancelledTmp.path,
      identity,
      content: complete,
      transition: "cancelled",
    })
    expect(cancelled.buildReady).toBe(false)
    expect(cancelled.reason).toBe("research was cancelled")

    await using staleTmp = await workspace()
    await updateResearchBrief({ workspacePath: staleTmp.path, identity, content: complete, transition: "approved" })
    await Bun.write(
      path.join(staleTmp.path, "request.json"),
      JSON.stringify({ ...identityToRequest(identity), requested_symbol: "QQQ" }),
    )
    const stale = await inspectResearchBrief(staleTmp.path)
    expect(stale.stale).toBe(true)
    expect(stale.buildReady).toBe(false)
    expect(stale.reason).toContain("does not match")
  })

  test("invalid and unsupported persisted versions fail closed", async () => {
    await using tmp = await workspace()
    await Bun.write(
      path.join(tmp.path, "research-brief.json"),
      JSON.stringify({ schema_version: 2, transition: "approved", identity, revision: 1 }),
    )

    const status = await inspectResearchBrief(tmp.path)
    expect(status.exists).toBe(true)
    expect(status.buildReady).toBe(false)
    expect(status.stale).toBe(true)
    expect(status.reason).toContain("unsupported schema version")
  })

  test("renders the approved artifact as authoritative Build context without dropping leakage rules", async () => {
    await using tmp = await workspace()
    const status = await updateResearchBrief({
      workspacePath: tmp.path,
      identity,
      content: complete,
      transition: "approved",
    })
    const rendered = renderResearchBriefHandoff(status.brief!)

    expect(rendered).toContain("authoritative Build handoff")
    expect(rendered).toContain('"requested_symbol": "SPY"')
    expect(rendered).toContain('"temporalLeakageRules"')
    expect(rendered).toContain("Signals use only completed bars")
    expect(rendered).toContain('"transition": "approved"')
    expect(rendered).toContain('"revision": 2')
  })

  test("rejects empty required list fields as incomplete", () => {
    expect(
      missingResearchBriefFields({
        ...complete,
        requiredDatasets: [],
        temporalLeakageRules: [],
        minimumEvidence: [],
      }),
    ).toEqual(expect.arrayContaining(["requiredDatasets", "temporalLeakageRules", "minimumEvidence"]))
  })

  test("keeps an approved handoff injectable when request.json was sparsely rewritten", async () => {
    await using tmp = await workspace()
    await updateResearchBrief({
      workspacePath: tmp.path,
      identity,
      content: complete,
      transition: "approved",
    })
    // Sparse Build prompt rewrite that drops interval/symbol facts.
    await Bun.write(
      path.join(tmp.path, "request.json"),
      JSON.stringify({ request_id: identity.request_id }),
    )
    const strict = await inspectResearchBrief(tmp.path)
    expect(strict.buildReady).toBe(false)
    expect(strict.stale).toBe(true)

    const forBuild = await inspectResearchBriefForBuildHandoff(tmp.path)
    expect(forBuild.buildReady).toBe(true)
    expect(forBuild.brief?.identity.requested_symbol).toBe("SPY")
    expect(forBuild.brief?.identity.requested_interval).toBe("15m")
  })

  test("still blocks Build handoff injection on hard identity conflicts", async () => {
    await using tmp = await workspace()
    await updateResearchBrief({
      workspacePath: tmp.path,
      identity,
      content: complete,
      transition: "approved",
    })
    await Bun.write(
      path.join(tmp.path, "request.json"),
      JSON.stringify({ ...identityToRequest(identity), requested_symbol: "QQQ" }),
    )
    const forBuild = await inspectResearchBriefForBuildHandoff(tmp.path)
    expect(forBuild.buildReady).toBe(false)
    expect(forBuild.reason).toContain("does not match")
  })
})
