import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { loadScenario, scenarioSha256 } from "./scenario"
import {
  HeadlessScenarioV1,
  ScenarioTerminalClassification,
  type ContractViolation,
  type HeadlessScenarioV1 as Scenario,
} from "./types"

const EvidenceIdentityV1 = z.object({
  schemaVersion: z.literal("1.0.0"),
  scenarioId: z.string().min(1),
  actualTerminalClassification: ScenarioTerminalClassification,
  telemetryGrade: z.enum(["valid", "critical", "invalid", "not_run"]),
  instruments: z.array(
    z.object({
      symbol: z.string().min(1),
      exchangeQualifiedTicker: z.string().min(1),
      venue: z.string().min(1),
      timezone: z.string().min(1),
      calendar: z.string().min(1),
      evidenceId: z.string().min(1),
      coverage: z.enum(["complete", "incomplete"]),
      providerStatus: z.enum(["healthy", "degraded"]),
      corporateActionStatus: z.enum(["resolved", "unresolved"]),
      priceBasis: z.enum(["adjusted", "unadjusted", "unknown"]),
      qualification: z.enum(["strict_qualified", "research_only"]),
      usableForResearch: z.boolean(),
    }),
  ),
})
export type EvidenceIdentityV1 = z.infer<typeof EvidenceIdentityV1>

export type ScenarioMatrixRow = {
  scenarioId: string
  partition: "workflow" | "identity" | "degradation"
  expectedTerminalClassification: z.infer<typeof ScenarioTerminalClassification>
  actualTerminalClassification: z.infer<typeof ScenarioTerminalClassification>
  scenarioSha256: string
  evidenceSha256?: string
  telemetryGrade: EvidenceIdentityV1["telemetryGrade"]
  violations: ContractViolation[]
  dependency?: { issue: number; reason: string }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function violation(code: string, message: string, evidence?: Record<string, unknown>): ContractViolation {
  return { code, message, ...(evidence ? { evidence } : {}) }
}

export function requireMatrixContract(
  scenario: Scenario,
): asserts scenario is Scenario &
  Required<
    Pick<Scenario, "expectedTerminalClassification" | "promotionLegallyPossible" | "evidencePolicy" | "matrix">
  > {
  if (
    !scenario.expectedTerminalClassification ||
    scenario.promotionLegallyPossible === undefined ||
    !scenario.evidencePolicy ||
    !scenario.matrix ||
    !scenario.request.instruments
  ) {
    throw new Error(`scenario ${scenario.id} is missing the v1 matrix contract`)
  }
  const expectedSymbols = [...scenario.request.symbols].sort()
  const identitySymbols = scenario.request.instruments.map((item) => item.symbol).sort()
  if (new Set(identitySymbols).size !== identitySymbols.length || stable(expectedSymbols) !== stable(identitySymbols)) {
    throw new Error(`scenario ${scenario.id} must declare exactly one identity invariant per requested symbol`)
  }
  if (scenario.matrix.dependency && scenario.expectedTerminalClassification !== "dependency_blocked") {
    throw new Error(`scenario ${scenario.id} declares a dependency but is not dependency_blocked`)
  }
}

export async function evaluateMatrixScenario(scenario: Scenario, rawEvidence?: unknown): Promise<ScenarioMatrixRow> {
  requireMatrixContract(scenario)
  if (scenario.matrix.dependency) {
    return {
      scenarioId: scenario.id,
      partition: scenario.matrix.partition,
      expectedTerminalClassification: scenario.expectedTerminalClassification,
      actualTerminalClassification: "dependency_blocked",
      scenarioSha256: scenarioSha256(scenario),
      telemetryGrade: "not_run",
      violations: [],
      dependency: scenario.matrix.dependency,
    }
  }
  if (!rawEvidence) throw new Error(`scenario ${scenario.id} is missing deterministic matrix evidence`)
  const evidence = EvidenceIdentityV1.parse(rawEvidence)
  const violations: ContractViolation[] = []
  if (evidence.scenarioId !== scenario.id) {
    violations.push(
      violation("scenario_id_drift", "Evidence scenario ID does not match the scenario.", {
        expected: scenario.id,
        observed: evidence.scenarioId,
      }),
    )
  }

  const expectedBySymbol = new Map(scenario.request.instruments!.map((item) => [item.symbol, item]))
  const observedBySymbol = new Map<string, EvidenceIdentityV1["instruments"]>()
  for (const instrument of evidence.instruments) {
    const siblings = observedBySymbol.get(instrument.symbol) ?? []
    siblings.push(instrument)
    observedBySymbol.set(instrument.symbol, siblings)
  }
  for (const symbol of scenario.request.symbols) {
    const observed = observedBySymbol.get(symbol) ?? []
    if (observed.length !== 1) {
      violations.push(
        violation(
          "symbol_evidence_cardinality",
          "Each requested symbol requires exactly one verified evidence identity.",
          {
            symbol,
            observed: observed.length,
          },
        ),
      )
      continue
    }
    const expected = expectedBySymbol.get(symbol)!
    const actual = observed[0]!
    for (const field of ["exchangeQualifiedTicker", "venue", "timezone", "calendar"] as const) {
      if (actual[field] !== expected[field]) {
        violations.push(
          violation(
            `instrument_${field}_drift`,
            `Evidence ${field} does not preserve the requested listing identity.`,
            {
              symbol,
              expected: expected[field],
              observed: actual[field],
            },
          ),
        )
      }
    }
  }
  for (const symbol of observedBySymbol.keys()) {
    if (!expectedBySymbol.has(symbol)) {
      violations.push(violation("unexpected_symbol_evidence", "Evidence contains an unrequested symbol.", { symbol }))
    }
  }

  const disqualified = evidence.instruments.some(
    (item) =>
      item.coverage === "incomplete" ||
      item.providerStatus === "degraded" ||
      item.corporateActionStatus === "unresolved" ||
      item.priceBasis === "unknown" ||
      item.qualification !== "strict_qualified",
  )
  if (evidence.actualTerminalClassification === "recommended_for_paper") {
    if (!scenario.promotionLegallyPossible) {
      violations.push(
        violation("promotion_legally_impossible", "Scenario contract forbids promotion to recommended_for_paper."),
      )
    }
    if (disqualified) {
      violations.push(
        violation("strict_qualification_evidence_invalid", "Non-strict evidence cannot produce recommended_for_paper."),
      )
    }
  }
  if (
    evidence.actualTerminalClassification === "research_only" &&
    (!scenario.evidencePolicy.researchOnlyAllowed ||
      evidence.instruments.some((instrument) => !instrument.usableForResearch))
  ) {
    violations.push(violation("research_only_not_allowed", "Evidence is not allowed to terminate as research_only."))
  }
  if (evidence.actualTerminalClassification !== scenario.expectedTerminalClassification) {
    violations.push(
      violation(
        "terminal_classification_mismatch",
        "Actual terminal classification differs from the scenario contract.",
        {
          expected: scenario.expectedTerminalClassification,
          observed: evidence.actualTerminalClassification,
        },
      ),
    )
  }

  return {
    scenarioId: scenario.id,
    partition: scenario.matrix.partition,
    expectedTerminalClassification: scenario.expectedTerminalClassification,
    actualTerminalClassification: violations.length ? "contract_failed" : evidence.actualTerminalClassification,
    scenarioSha256: scenarioSha256(scenario),
    evidenceSha256: await sha256(evidence),
    telemetryGrade: evidence.telemetryGrade,
    violations,
  }
}

export async function loadMatrixRows(input: {
  scenariosDir: string
  fixturesDir: string
  partition?: ScenarioMatrixRow["partition"]
}): Promise<ScenarioMatrixRow[]> {
  const files = (await fs.readdir(input.scenariosDir)).filter((file) => file.endsWith(".v1.json")).sort()
  const rows: ScenarioMatrixRow[] = []
  const ids = new Set<string>()
  for (const file of files) {
    const scenario = await loadScenario(path.join(input.scenariosDir, file))
    requireMatrixContract(scenario)
    if (scenario.matrix.partition !== input.partition && input.partition) continue
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario ID ${scenario.id}`)
    ids.add(scenario.id)
    if (file !== `${scenario.id}.json`) throw new Error(`scenario file ${file} must match stable ID ${scenario.id}`)
    const fixture = scenario.matrix.fixture
      ? JSON.parse(await fs.readFile(path.join(input.fixturesDir, scenario.matrix.fixture), "utf8"))
      : undefined
    rows.push(await evaluateMatrixScenario(scenario, fixture))
  }
  return rows
}

export { EvidenceIdentityV1, HeadlessScenarioV1 }
