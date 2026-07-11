import matter from "gray-matter"
import type { ObservedBacktestRun, ObservedSavedCandidate } from "./run-artifacts"
import type { ContractViolation, HarnessStageName, HarnessStatus, HeadlessScenarioV1 } from "./types"

type JsonEvent = Record<string, any>

export type HarnessObservation = {
  mainSession?: string
  toolCalls: number
  modelTurns: number
  subagents: Array<{ id: string; type?: string }>
  algorithms: string[]
  versionsByAlgorithm: Record<string, number>
  backtests: number
  completedBacktests: number
  savedCandidates: ObservedSavedCandidate[]
  backtestRuns: ObservedBacktestRun[]
  requestIdentity: {
    symbols: string[]
    assetClasses: string[]
    intervals: string[]
    startDates: string[]
    endDates: string[]
    strategyFamilies: string[]
    sources: Record<string, Record<string, string[]>>
  }
  stages: Record<string, "completed" | "missing" | "failed">
  finalText: string
  recoveries: Array<{ kind: string; allowed: boolean; detail?: string }>
  errors: Array<{ kind: string; message: string }>
  violations: ContractViolation[]
}

type IdentitySets = {
  symbols: Set<string>
  assetClasses: Set<string>
  intervals: Set<string>
  startDates: Set<string>
  endDates: Set<string>
  strategyFamilies: Set<string>
}

function identitySets(): IdentitySets {
  return {
    symbols: new Set(),
    assetClasses: new Set(),
    intervals: new Set(),
    startDates: new Set(),
    endDates: new Set(),
    strategyFamilies: new Set(),
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

function valuesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function addValues(target: Set<string>, value: unknown, canonical: (value: unknown) => string): void {
  for (const item of valuesOf(value)) {
    const normalized = canonical(item)
    if (normalized) target.add(normalized)
  }
}

function toolPart(event: JsonEvent): Record<string, any> | undefined {
  if (event.type !== "tool_use") return
  const part = event.part
  return part && typeof part === "object" ? part : undefined
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

function canonicalSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
}

function canonicalAssetClass(value: unknown): string {
  const normalized = normalize(value)
  return normalized === "equities" ? "equity" : normalized
}

function canonicalInterval(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
  const aliases: Record<string, string> = {
    "5min": "5m",
    "5mins": "5m",
    "5minute": "5m",
    "5minutes": "5m",
  }
  return aliases[normalized] ?? normalized
}

function canonicalDate(value: unknown): string {
  return String(value ?? "").trim()
}

// @codescene(disable-all) Saved-config parsing is the compatibility boundary for model output.
function parseSavedConfig(value: unknown): Record<string, any> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== "string" || value.trim().length === 0) return
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return
  }
}

function parseMission(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string" || !value.trimStart().startsWith("---")) return
  try {
    return asRecord(matter(value).data)
  } catch {
    return
  }
}

function addWindow(target: IdentitySets, value: unknown): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const window = asRecord(value)
    addValues(target.startDates, window.start ?? window.startDate ?? window.start_date, canonicalDate)
    addValues(target.endDates, window.end ?? window.endDate ?? window.end_date, canonicalDate)
    return
  }
  if (typeof value !== "string") return
  const dates = value.match(/\d{4}-\d{2}-\d{2}/g) ?? []
  if (dates[0]) target.startDates.add(dates[0])
  if (dates[1]) target.endDates.add(dates[1])
}

function mergeIdentity(...sources: IdentitySets[]): IdentitySets {
  const merged = identitySets()
  for (const source of sources) {
    for (const key of Object.keys(merged) as Array<keyof IdentitySets>) {
      for (const value of source[key]) merged[key].add(value)
    }
  }
  return merged
}

function serializeIdentity(source: IdentitySets): Omit<HarnessObservation["requestIdentity"], "sources"> {
  return {
    symbols: [...source.symbols].sort(),
    assetClasses: [...source.assetClasses].sort(),
    intervals: [...source.intervals].sort(),
    startDates: [...source.startDates].sort(),
    endDates: [...source.endDates].sort(),
    strategyFamilies: [...source.strategyFamilies].sort(),
  }
}

function completed(part: Record<string, any>): boolean {
  return part.state?.status === "completed"
}

function failed(part: Record<string, any>): boolean {
  return part.state?.status === "error"
}

function inputOf(part: Record<string, any>): Record<string, any> {
  return part.state?.input && typeof part.state.input === "object" ? part.state.input : {}
}

function outputOf(part: Record<string, any>): string {
  return typeof part.state?.output === "string" ? part.state.output : ""
}

function metadataOf(part: Record<string, any>): Record<string, any> {
  return part.state?.metadata && typeof part.state.metadata === "object" ? part.state.metadata : {}
}

function addViolation(
  violations: ContractViolation[],
  code: string,
  message: string,
  evidence?: Record<string, unknown>,
) {
  violations.push({ code, message, ...(evidence ? { evidence } : {}) })
}

export function parseJsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === "object") events.push(parsed)
    } catch {
      // Non-JSON diagnostics are retained in raw stdout and do not make the
      // event stream invalid by themselves.
    }
  }
  return events
}

// @codescene(disable-all) Observation is the single semantic reduction boundary for the harness contract.
export function observeRun(events: JsonEvent[], scenario: HeadlessScenarioV1): HarnessObservation {
  const algorithms = new Set<string>()
  const versionsByAlgorithm: Record<string, number> = {}
  const subagents = new Map<string, { id: string; type?: string }>()
  const completedStages = new Set<HarnessStageName>()
  const failedStages = new Set<HarnessStageName>()
  const recoveries: HarnessObservation["recoveries"] = []
  const errors: HarnessObservation["errors"] = []
  const violations: ContractViolation[] = []
  const preparedIdentity = identitySets()
  const candidateIdentity = identitySets()
  const backtestIdentity = identitySets()
  const savedCandidates: ObservedSavedCandidate[] = []
  const backtestRuns: ObservedBacktestRun[] = []
  const finalTexts: string[] = []
  let toolCalls = 0
  let modelTurns = 0
  let backtests = 0
  let completedBacktests = 0

  for (const event of events) {
    if (event.type === "step_finish") modelTurns++
    if (event.type === "text" && typeof event.part?.text === "string") finalTexts.push(event.part.text)
    if (event.type === "error") {
      const message = typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {})
      errors.push({ kind: "session_error", message })
    }

    const part = toolPart(event)
    if (!part) continue
    toolCalls++
    const input = inputOf(part)
    const output = outputOf(part)
    const metadata = metadataOf(part)
    if (part.tool === "finny_workspace_prepare" && completed(part)) {
      completedStages.add("request_bound")
      addValues(preparedIdentity.symbols, input.symbols ?? input.symbol, canonicalSymbol)
      addValues(preparedIdentity.assetClasses, input.assetClass ?? input.asset_class, canonicalAssetClass)
      addValues(preparedIdentity.intervals, input.interval, canonicalInterval)
      addValues(preparedIdentity.startDates, input.startDate ?? input.start_date, canonicalDate)
      addValues(preparedIdentity.endDates, input.endDate ?? input.end_date, canonicalDate)
      addValues(
        preparedIdentity.strategyFamilies,
        input.strategyFamily ?? input.strategy_family ?? input.strategyIntent ?? input.strategy_intent,
        normalize,
      )
    }
    if (part.tool === "task") {
      const declaredChildren = Array.isArray(metadata.subagents) ? metadata.subagents : []
      if (declaredChildren.length > 0) {
        for (const child of declaredChildren) {
          const childRecord = asRecord(child)
          const id = String(
            (typeof child === "string" ? child : undefined) ??
              childRecord.id ??
              childRecord.sessionId ??
              childRecord.sessionID ??
              childRecord.session_id ??
              childRecord.subagentId ??
              "",
          )
          if (!id) continue
          const type =
            String(childRecord.type ?? childRecord.subagentType ?? childRecord.subagent_type ?? "") || undefined
          subagents.set(id, { id, ...(type ? { type } : {}) })
        }
      } else {
        const id = String(metadata.sessionId ?? metadata.sessionID ?? part.id ?? `task-${toolCalls}`)
        const type = String(input.subagent_type ?? input.subagentType ?? metadata.subagentType ?? "") || undefined
        subagents.set(id, { id, ...(type ? { type } : {}) })
      }
      if (completed(part) && /data-extractor-manifest|usable_for_parent:\s*yes/i.test(output)) {
        completedStages.add("evidence_ready")
      }
    }
    if (part.tool === "finny_algorithm_save") {
      const name = String(input.name ?? metadata.name ?? metadata.algorithmName ?? "").trim()
      if (name) {
        algorithms.add(name)
        const version = Number(metadata.version ?? 1)
        versionsByAlgorithm[name] = Math.max(versionsByAlgorithm[name] ?? 0, Number.isFinite(version) ? version : 1)
      }
      if (completed(part) && !metadata.blocked) {
        completedStages.add("candidate_saved")
        completedStages.add("validated")
        savedCandidates.push({
          ...(name ? { name } : {}),
          ...(typeof metadata.algorithmId === "string" ? { algorithmId: metadata.algorithmId } : {}),
          ...(Number.isInteger(metadata.version) ? { version: Number(metadata.version) } : {}),
        })

        const config = parseSavedConfig(input.config)
        if (!config) {
          addViolation(violations, "candidate_config_invalid", "Saved candidate config is not structured JSON.")
        } else {
          const configStrategy = asRecord(config.strategy)
          addValues(candidateIdentity.symbols, config.symbols ?? config.symbol, canonicalSymbol)
          addValues(candidateIdentity.assetClasses, config.assetClass ?? config.asset_class, canonicalAssetClass)
          addValues(candidateIdentity.intervals, config.interval ?? config.bar_interval, canonicalInterval)
          addValues(candidateIdentity.startDates, config.startDate ?? config.start_date, canonicalDate)
          addValues(candidateIdentity.endDates, config.endDate ?? config.end_date, canonicalDate)
          addValues(
            candidateIdentity.strategyFamilies,
            config.strategyFamily ?? config.strategy_family ?? configStrategy.type,
            normalize,
          )
          addWindow(candidateIdentity, config.backtestWindow ?? config.backtest_window)
        }

        const mission = parseMission(input.mission)
        if (!mission) {
          addViolation(
            violations,
            "candidate_mission_invalid",
            "Saved candidate mission is missing parseable YAML frontmatter.",
          )
        } else {
          const scope = asRecord(mission.scope)
          const strategy = asRecord(mission.strategy)
          addValues(candidateIdentity.symbols, scope.universe, canonicalSymbol)
          addValues(candidateIdentity.assetClasses, scope.asset_class ?? scope.assetClass, canonicalAssetClass)
          addValues(candidateIdentity.intervals, strategy.bar_interval ?? strategy.interval, canonicalInterval)
          addValues(candidateIdentity.strategyFamilies, strategy.type, normalize)
          addWindow(candidateIdentity, strategy.backtest_window ?? strategy.backtestWindow)
        }
      } else if (failed(part)) {
        failedStages.add("candidate_saved")
      }
    }
    if (part.tool === "finny_algorithm_validate") {
      if (completed(part) && !/validation failed|invalid/i.test(output)) completedStages.add("validated")
      else if (failed(part)) failedStages.add("validated")
    }
    if (part.tool === "finny_backtest" || part.tool === "finny_backtest_run") {
      backtests++
      addValues(backtestIdentity.symbols, input.symbols ?? input.symbol, canonicalSymbol)
      addValues(backtestIdentity.assetClasses, input.assetClass ?? input.asset_class, canonicalAssetClass)
      addValues(backtestIdentity.intervals, input.interval, canonicalInterval)
      addValues(backtestIdentity.startDates, input.startDate ?? input.start_date, canonicalDate)
      addValues(backtestIdentity.endDates, input.endDate ?? input.end_date, canonicalDate)
      const name = String(input.algorithmName ?? metadata.algorithmName ?? "").trim()
      if (name) algorithms.add(name)
      if (completed(part) && !metadata.blocked && /Verdict:|Total return:|Eligibility:/i.test(output)) {
        completedBacktests++
        const resultMetadata = asRecord(metadata.results)
        backtestRuns.push({
          ...(name ? { algorithmName: name } : {}),
          ...(typeof resultMetadata.runId === "string" ? { runId: resultMetadata.runId } : {}),
          ...(typeof resultMetadata.artifactDir === "string" ? { artifactDir: resultMetadata.artifactDir } : {}),
        })
        completedStages.add("backtested")
        completedStages.add("reviewable")
      } else if (failed(part)) {
        failedStages.add("backtested")
      }
    }

    if (failed(part) || metadata.recovered === true) {
      const kind = String(metadata.kind ?? `${part.tool}_${failed(part) ? "error" : "recovery"}`)
      const allowed = scenario.allowedRecoveries.includes(kind)
      recoveries.push({
        kind,
        allowed,
        detail: failed(part) ? String(part.state?.error ?? "tool error") : output.slice(0, 500),
      })
    }
  }

  const finalText = finalTexts.at(-1) ?? ""
  const stages: HarnessObservation["stages"] = {}
  for (const stage of scenario.requiredStages) {
    stages[stage] = completedStages.has(stage) ? "completed" : failedStages.has(stage) ? "failed" : "missing"
    if (stages[stage] !== "completed") {
      addViolation(violations, "required_stage_missing", `Required stage ${stage} did not complete.`, {
        stage,
        observed: stages[stage],
      })
    }
  }

  if (toolCalls > scenario.limits.toolCalls) {
    addViolation(
      violations,
      "tool_call_limit",
      `Observed ${toolCalls} tool calls; limit is ${scenario.limits.toolCalls}.`,
    )
  }
  if (modelTurns > scenario.limits.modelTurns) {
    addViolation(
      violations,
      "model_turn_limit",
      `Observed ${modelTurns} model turns; limit is ${scenario.limits.modelTurns}.`,
    )
  }
  if (subagents.size > scenario.limits.subagents) {
    addViolation(
      violations,
      "subagent_limit",
      `Observed ${subagents.size} subagents; limit is ${scenario.limits.subagents}.`,
    )
  }
  if (algorithms.size > scenario.artifactPolicy.maxAlgorithms) {
    addViolation(
      violations,
      "algorithm_limit",
      `Observed ${algorithms.size} algorithms; limit is ${scenario.artifactPolicy.maxAlgorithms}.`,
      {
        algorithms: [...algorithms],
      },
    )
  }
  for (const [algorithm, versions] of Object.entries(versionsByAlgorithm)) {
    if (versions > scenario.artifactPolicy.maxVersionsPerAlgorithm) {
      addViolation(
        violations,
        "version_limit",
        `${algorithm} produced ${versions} versions; limit is ${scenario.artifactPolicy.maxVersionsPerAlgorithm}.`,
      )
    }
  }
  if (backtests > scenario.artifactPolicy.maxBacktests) {
    addViolation(
      violations,
      "backtest_limit",
      `Observed ${backtests} backtests; limit is ${scenario.artifactPolicy.maxBacktests}.`,
    )
  }

  const identitySources: Array<[string, IdentitySets, Array<keyof IdentitySets>]> = [
    [
      "request_bound",
      preparedIdentity,
      ["symbols", "assetClasses", "intervals", "startDates", "endDates", "strategyFamilies"],
    ],
    [
      "candidate_saved",
      candidateIdentity,
      ["symbols", "assetClasses", "intervals", "startDates", "endDates", "strategyFamilies"],
    ],
    ["backtested", backtestIdentity, ["intervals", "startDates", "endDates"]],
  ]
  for (const [stage, source, required] of identitySources) {
    if (!completedStages.has(stage as HarnessStageName)) continue
    for (const field of required) {
      if (source[field].size === 0) {
        addViolation(
          violations,
          "request_identity_missing",
          `Completed stage ${stage} is missing structured ${field}.`,
          {
            stage,
            field,
          },
        )
      }
    }
  }

  const observedIdentity = mergeIdentity(preparedIdentity, candidateIdentity, backtestIdentity)
  const exactFields: Array<{
    code: string
    field: keyof IdentitySets
    expected: string[]
  }> = [
    { code: "request_symbol_mismatch", field: "symbols", expected: scenario.request.symbols.map(canonicalSymbol) },
    {
      code: "request_asset_class_mismatch",
      field: "assetClasses",
      expected: [canonicalAssetClass(scenario.request.assetClass)],
    },
    { code: "request_interval_mismatch", field: "intervals", expected: [canonicalInterval(scenario.request.interval)] },
    { code: "request_start_date_mismatch", field: "startDates", expected: [canonicalDate(scenario.request.startDate)] },
    { code: "request_end_date_mismatch", field: "endDates", expected: [canonicalDate(scenario.request.endDate)] },
  ]
  if (
    completedStages.has("request_bound") ||
    completedStages.has("candidate_saved") ||
    completedStages.has("backtested")
  ) {
    for (const { code, field, expected } of exactFields) {
      const actual = [...observedIdentity[field]].sort()
      const wanted = [...new Set(expected)].sort()
      if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
        addViolation(violations, code, `Observed ${field} do not exactly match the scenario request.`, {
          expected: wanted,
          observed: actual,
        })
      }
    }
  }

  const allowedFamilies = new Set(scenario.request.strategyFamilies.map(normalize))
  if (completedStages.has("request_bound")) {
    const requestedFamilies = [...preparedIdentity.strategyFamilies]
    if (requestedFamilies.length === 0 || requestedFamilies.some((family) => !allowedFamilies.has(family))) {
      addViolation(
        violations,
        "request_strategy_family_mismatch",
        "Bound request does not declare an allowed strategy family.",
        {
          allowed: [...allowedFamilies],
          observed: requestedFamilies,
        },
      )
    }
  }
  if (completedStages.has("candidate_saved")) {
    const candidateFamilies = [...candidateIdentity.strategyFamilies]
    if (candidateFamilies.length === 0) {
      addViolation(
        violations,
        "strategy_family_missing",
        "Saved candidate has no structured strategy family declaration.",
      )
    } else if (candidateFamilies.some((family) => !allowedFamilies.has(family))) {
      addViolation(
        violations,
        "strategy_family_drift",
        "Saved candidate declares a strategy family outside the scenario.",
        {
          allowed: [...allowedFamilies],
          observed: candidateFamilies,
        },
      )
    }
  }

  for (const field of scenario.requiredFinalFields) {
    if (!finalText.toLowerCase().includes(field.toLowerCase())) {
      addViolation(violations, "final_field_missing", `Final response is missing required field ${field}.`, { field })
    }
  }
  for (const recovery of recoveries) {
    if (!recovery.allowed)
      addViolation(violations, "unapproved_recovery", `Recovery ${recovery.kind} is not allowed by the scenario.`)
  }

  return {
    mainSession: events.find((event) => typeof event.sessionID === "string")?.sessionID,
    toolCalls,
    modelTurns,
    subagents: [...subagents.values()],
    algorithms: [...algorithms],
    versionsByAlgorithm,
    backtests,
    completedBacktests,
    savedCandidates,
    backtestRuns,
    requestIdentity: {
      ...serializeIdentity(observedIdentity),
      sources: {
        request_bound: serializeIdentity(preparedIdentity),
        candidate_saved: serializeIdentity(candidateIdentity),
        backtested: serializeIdentity(backtestIdentity),
      },
    },
    stages,
    finalText,
    recoveries,
    errors,
    violations,
  }
}

// @codescene(disable-all) Outcome classification is the single semantic exit-code policy.
export function classifyOutcome(input: {
  preflightFailed?: boolean
  timedOut?: boolean
  interrupted?: boolean
  internalError?: boolean
  childExitCode?: number
  integrityErrors?: string[]
  observabilityErrors?: string[]
  observabilityRequired?: boolean
  observabilityAvailable?: boolean
  observation: HarnessObservation
}): { status: HarnessStatus; exitCode: number } {
  if (input.interrupted) return { status: "interrupted", exitCode: 130 }
  if (input.internalError) return { status: "internal_error", exitCode: 70 }
  if (input.preflightFailed) return { status: "preflight_failed", exitCode: 3 }
  if (input.observabilityRequired && !input.observabilityAvailable) {
    return { status: "evidence_invalid", exitCode: 5 }
  }
  if (input.integrityErrors?.length) return { status: "evidence_invalid", exitCode: 5 }
  if (input.timedOut) return { status: "timed_out", exitCode: 4 }
  if ((input.childExitCode ?? 0) !== 0 || input.observation.errors.length > 0) {
    return { status: "execution_failed", exitCode: 4 }
  }
  if (input.observabilityErrors?.length) return { status: "evidence_invalid", exitCode: 5 }
  if (input.observation.violations.length > 0) return { status: "contract_failed", exitCode: 2 }
  if (input.observation.recoveries.length > 0) return { status: "completed_with_recoveries", exitCode: 0 }
  return { status: "completed", exitCode: 0 }
}
