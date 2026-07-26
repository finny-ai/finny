import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceIdentityV1, evaluateMatrixScenario, loadMatrixRows } from "../../script/headless/scenario-matrix"
import { loadScenario } from "../../script/headless/scenario"

const packageRoot = path.resolve(import.meta.dir, "../..")
const scenariosDir = path.join(packageRoot, "harness/scenarios")
const fixturesDir = path.join(packageRoot, "harness/fixtures")

async function inputs(id: string) {
  const scenario = await loadScenario(path.join(scenariosDir, `${id}.json`))
  const raw = JSON.parse(await fs.readFile(path.join(fixturesDir, `${id}.evidence.json`), "utf8"))
  return { scenario, evidence: EvidenceIdentityV1.parse(raw) }
}

describe("deterministic headless scenario matrix", () => {
  test("manifest index has six stable versioned rows and no contract violations", async () => {
    const rows = await loadMatrixRows({ scenariosDir, fixturesDir })
    expect(rows.map((row) => row.scenarioId)).toEqual([
      "btc-usd-24x7.v1",
      "shop-tsx-exact-listing.v1",
      "spy-5m-sma-crossover.v1",
      "spy-provider-degraded.v1",
      "spy-qqq-complete-evidence.v1",
      "strict-positive-qualification.v1",
    ])
    expect(rows.every((row) => row.scenarioSha256.length === 64)).toBe(true)
    expect(rows.filter((row) => row.evidenceSha256).every((row) => row.evidenceSha256!.length === 64)).toBe(true)
    expect(rows.flatMap((row) => row.violations)).toEqual([])
    expect(rows.find((row) => row.scenarioId === "strict-positive-qualification.v1")).toMatchObject({
      actualTerminalClassification: "dependency_blocked",
      dependency: { issue: 44 },
      telemetryGrade: "not_run",
    })
  })

  test("multi-symbol evidence fails closed when one requested symbol is missing", async () => {
    const { scenario, evidence } = await inputs("spy-qqq-complete-evidence.v1")
    const row = await evaluateMatrixScenario(scenario, { ...evidence, instruments: evidence.instruments.slice(0, 1) })
    expect(row.actualTerminalClassification).toBe("contract_failed")
    expect(row.violations).toContainEqual(
      expect.objectContaining({
        code: "symbol_evidence_cardinality",
        evidence: expect.objectContaining({ symbol: "QQQ", observed: 0 }),
      }),
    )
  })

  test("crypto rejects XNYS drift instead of silently applying equity sessions", async () => {
    const { scenario, evidence } = await inputs("btc-usd-24x7.v1")
    const row = await evaluateMatrixScenario(scenario, {
      ...evidence,
      instruments: [{ ...evidence.instruments[0], calendar: "XNYS", timezone: "America/New_York" }],
    })
    expect(row.actualTerminalClassification).toBe("contract_failed")
    expect(row.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(["instrument_calendar_drift", "instrument_timezone_drift"]),
    )
  })

  test("regional listing rejects a US proxy and preserves venue, timezone, and calendar", async () => {
    const { scenario, evidence } = await inputs("shop-tsx-exact-listing.v1")
    const row = await evaluateMatrixScenario(scenario, {
      ...evidence,
      instruments: [
        {
          ...evidence.instruments[0],
          symbol: "SHOP",
          exchangeQualifiedTicker: "SHOP@XNYS",
          venue: "XNYS",
          timezone: "America/New_York",
          calendar: "XNYS",
        },
      ],
    })
    expect(row.actualTerminalClassification).toBe("contract_failed")
    expect(row.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(["symbol_evidence_cardinality", "unexpected_symbol_evidence"]),
    )
  })

  test("degraded or unresolved evidence cannot claim recommended_for_paper", async () => {
    const { scenario, evidence } = await inputs("spy-provider-degraded.v1")
    const row = await evaluateMatrixScenario(scenario, {
      ...evidence,
      actualTerminalClassification: "recommended_for_paper",
    })
    expect(row.actualTerminalClassification).toBe("contract_failed")
    expect(row.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "promotion_legally_impossible",
        "strict_qualification_evidence_invalid",
        "terminal_classification_mismatch",
      ]),
    )
  })

  test("identical isolated loads produce identical scenario and evidence hashes", async () => {
    const left = await loadMatrixRows({ scenariosDir, fixturesDir, partition: "identity" })
    const right = await loadMatrixRows({ scenariosDir, fixturesDir, partition: "identity" })
    expect(left).toEqual(right)
  })
})
