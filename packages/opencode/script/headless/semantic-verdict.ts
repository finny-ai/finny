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

function asObjectRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) return
  return value as Record<string, any>
}

function parseSavedConfig(value: unknown): Record<string, any> | undefined {
  const direct = asObjectRecord(value)
  if (direct) return direct
  if (typeof value !== "string") return
  if (value.trim().length === 0) return
  try {
    return asObjectRecord(JSON.parse(value))
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

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function addObjectWindow(target: IdentitySets, value: Record<string, any>): void {
  addValues(target.startDates, value.start ?? value.startDate ?? value.start_date, canonicalDate)
  addValues(target.endDates, value.end ?? value.endDate ?? value.end_date, canonicalDate)
}

function addStringWindow(target: IdentitySets, value: string): void {
  const dates = value.match(/\d{4}-\d{2}-\d{2}/g) ?? []
  if (dates[0]) target.startDates.add(dates[0])
  if (dates[1]) target.endDates.add(dates[1])
}

function addWindow(target: IdentitySets, value: unknown): void {
  if (isPlainObject(value)) {
    addObjectWindow(target, value)
    return
  }
  if (typeof value === "string") addStringWindow(target, value)
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

type ObserveState = {
  algorithms: Set<string>
  versionsByAlgorithm: Record<string, number>
  subagents: Map<string, { id: string; type?: string }>
  completedStages: Set<HarnessStageName>
  failedStages: Set<HarnessStageName>
  recoveries: HarnessObservation["recoveries"]
  errors: HarnessObservation["errors"]
  violations: ContractViolation[]
  preparedIdentity: IdentitySets
  candidateIdentity: IdentitySets
  backtestIdentity: IdentitySets
  savedCandidates: ObservedSavedCandidate[]
  backtestRuns: ObservedBacktestRun[]
  finalTexts: string[]
  toolCalls: number
  modelTurns: number
  backtests: number
  completedBacktests: number
}

function createObserveState(): ObserveState {
  return {
    algorithms: new Set(),
    versionsByAlgorithm: {},
    subagents: new Map(),
    completedStages: new Set(),
    failedStages: new Set(),
    recoveries: [],
    errors: [],
    violations: [],
    preparedIdentity: identitySets(),
    candidateIdentity: identitySets(),
    backtestIdentity: identitySets(),
    savedCandidates: [],
    backtestRuns: [],
    finalTexts: [],
    toolCalls: 0,
    modelTurns: 0,
    backtests: 0,
    completedBacktests: 0,
  }
}

function noteSubagent(state: ObserveState, id: string, type?: string): void {
  if (!id) return
  state.subagents.set(id, { id, ...(type ? { type } : {}) })
}

function childSessionId(child: unknown): string {
  if (typeof child === "string") return child
  const childRecord = asRecord(child)
  return String(
    childRecord.id ??
      childRecord.sessionId ??
      childRecord.sessionID ??
      childRecord.session_id ??
      childRecord.subagentId ??
      "",
  )
}

function childSessionType(child: unknown): string | undefined {
  const childRecord = asRecord(child)
  return String(childRecord.type ?? childRecord.subagentType ?? childRecord.subagent_type ?? "") || undefined
}

function noteDeclaredSubagents(state: ObserveState, metadata: Record<string, any>): boolean {
  const declaredChildren = Array.isArray(metadata.subagents) ? metadata.subagents : []
  if (declaredChildren.length === 0) return false
  for (const child of declaredChildren) {
    noteSubagent(state, childSessionId(child), childSessionType(child))
  }
  return true
}

function noteSingleTaskSubagent(state: ObserveState, part: Record<string, any>): void {
  const input = inputOf(part)
  const metadata = metadataOf(part)
  const id = String(metadata.sessionId ?? metadata.sessionID ?? part.id ?? `task-${state.toolCalls}`)
  const type = String(input.subagent_type ?? input.subagentType ?? metadata.subagentType ?? "") || undefined
  noteSubagent(state, id, type)
}

function markEvidenceReady(state: ObserveState, part: Record<string, any>): void {
  if (!completed(part)) return
  const output = outputOf(part)
  if (!/data-extractor-manifest|usable_for_parent:\s*yes/i.test(output)) return
  state.completedStages.add("evidence_ready")
}

function observeTaskPart(state: ObserveState, part: Record<string, any>): void {
  const metadata = metadataOf(part)
  if (!noteDeclaredSubagents(state, metadata)) noteSingleTaskSubagent(state, part)
  markEvidenceReady(state, part)
}

function observePreparePart(state: ObserveState, part: Record<string, any>): void {
  if (!completed(part)) return
  const input = inputOf(part)
  state.completedStages.add("request_bound")
  addValues(state.preparedIdentity.symbols, input.symbols ?? input.symbol, canonicalSymbol)
  addValues(state.preparedIdentity.assetClasses, input.assetClass ?? input.asset_class, canonicalAssetClass)
  addValues(state.preparedIdentity.intervals, input.interval, canonicalInterval)
  addValues(state.preparedIdentity.startDates, input.startDate ?? input.start_date, canonicalDate)
  addValues(state.preparedIdentity.endDates, input.endDate ?? input.end_date, canonicalDate)
  addValues(
    state.preparedIdentity.strategyFamilies,
    input.strategyFamily ?? input.strategy_family ?? input.strategyIntent ?? input.strategy_intent,
    normalize,
  )
}

function observeSavedConfig(state: ObserveState, input: Record<string, any>): void {
  const config = parseSavedConfig(input.config)
  if (!config) {
    addViolation(state.violations, "candidate_config_invalid", "Saved candidate config is not structured JSON.")
    return
  }
  const configStrategy = asRecord(config.strategy)
  addValues(state.candidateIdentity.symbols, config.symbols ?? config.symbol, canonicalSymbol)
  addValues(state.candidateIdentity.assetClasses, config.assetClass ?? config.asset_class, canonicalAssetClass)
  addValues(state.candidateIdentity.intervals, config.interval ?? config.bar_interval, canonicalInterval)
  addValues(state.candidateIdentity.startDates, config.startDate ?? config.start_date, canonicalDate)
  addValues(state.candidateIdentity.endDates, config.endDate ?? config.end_date, canonicalDate)
  addValues(
    state.candidateIdentity.strategyFamilies,
    config.strategyFamily ?? config.strategy_family ?? configStrategy.type,
    normalize,
  )
  addWindow(state.candidateIdentity, config.backtestWindow ?? config.backtest_window)
}

function observeSavedMission(state: ObserveState, input: Record<string, any>): void {
  const mission = parseMission(input.mission)
  if (!mission) {
    addViolation(
      state.violations,
      "candidate_mission_invalid",
      "Saved candidate mission is missing parseable YAML frontmatter.",
    )
    return
  }
  const scope = asRecord(mission.scope)
  const strategy = asRecord(mission.strategy)
  addValues(state.candidateIdentity.symbols, scope.universe, canonicalSymbol)
  addValues(state.candidateIdentity.assetClasses, scope.asset_class ?? scope.assetClass, canonicalAssetClass)
  addValues(state.candidateIdentity.intervals, strategy.bar_interval ?? strategy.interval, canonicalInterval)
  addValues(state.candidateIdentity.strategyFamilies, strategy.type, normalize)
  addWindow(state.candidateIdentity, strategy.backtest_window ?? strategy.backtestWindow)
}

function trackSavedAlgorithm(state: ObserveState, part: Record<string, any>): string {
  const input = inputOf(part)
  const metadata = metadataOf(part)
  const name = String(input.name ?? metadata.name ?? metadata.algorithmName ?? "").trim()
  if (!name) return ""
  state.algorithms.add(name)
  const version = Number(metadata.version ?? 1)
  const normalized = Number.isFinite(version) ? version : 1
  state.versionsByAlgorithm[name] = Math.max(state.versionsByAlgorithm[name] ?? 0, normalized)
  return name
}

function recordSavedCandidate(state: ObserveState, name: string, metadata: Record<string, any>): void {
  state.savedCandidates.push({
    ...(name ? { name } : {}),
    ...(typeof metadata.algorithmId === "string" ? { algorithmId: metadata.algorithmId } : {}),
    ...(Number.isInteger(metadata.version) ? { version: Number(metadata.version) } : {}),
  })
}

function observeSuccessfulSave(state: ObserveState, part: Record<string, any>, name: string): void {
  const input = inputOf(part)
  const metadata = metadataOf(part)
  state.completedStages.add("candidate_saved")
  state.completedStages.add("validated")
  recordSavedCandidate(state, name, metadata)
  observeSavedConfig(state, input)
  observeSavedMission(state, input)
}

function observeSavePart(state: ObserveState, part: Record<string, any>): void {
  const name = trackSavedAlgorithm(state, part)
  const metadata = metadataOf(part)
  if (completed(part) && !metadata.blocked) {
    observeSuccessfulSave(state, part, name)
    return
  }
  if (failed(part)) state.failedStages.add("candidate_saved")
}

function observeValidatePart(state: ObserveState, part: Record<string, any>): void {
  const output = outputOf(part)
  if (completed(part) && !/validation failed|invalid/i.test(output)) state.completedStages.add("validated")
  else if (failed(part)) state.failedStages.add("validated")
}

function noteBacktestIdentity(state: ObserveState, input: Record<string, any>): void {
  addValues(state.backtestIdentity.symbols, input.symbols ?? input.symbol, canonicalSymbol)
  addValues(state.backtestIdentity.assetClasses, input.assetClass ?? input.asset_class, canonicalAssetClass)
  addValues(state.backtestIdentity.intervals, input.interval, canonicalInterval)
  addValues(state.backtestIdentity.startDates, input.startDate ?? input.start_date, canonicalDate)
  addValues(state.backtestIdentity.endDates, input.endDate ?? input.end_date, canonicalDate)
}

function backtestSucceeded(part: Record<string, any>): boolean {
  if (!completed(part)) return false
  if (metadataOf(part).blocked) return false
  return /Verdict:|Total return:|Eligibility:/i.test(outputOf(part))
}

function recordCompletedBacktest(state: ObserveState, part: Record<string, any>, name: string): void {
  state.completedBacktests++
  const resultMetadata = asRecord(metadataOf(part).results)
  state.backtestRuns.push({
    ...(name ? { algorithmName: name } : {}),
    ...(typeof resultMetadata.runId === "string" ? { runId: resultMetadata.runId } : {}),
    ...(typeof resultMetadata.artifactDir === "string" ? { artifactDir: resultMetadata.artifactDir } : {}),
  })
  state.completedStages.add("backtested")
  state.completedStages.add("reviewable")
}

function observeBacktestPart(state: ObserveState, part: Record<string, any>): void {
  const input = inputOf(part)
  const metadata = metadataOf(part)
  state.backtests++
  noteBacktestIdentity(state, input)
  const name = String(input.algorithmName ?? metadata.algorithmName ?? "").trim()
  if (name) state.algorithms.add(name)
  if (backtestSucceeded(part)) {
    recordCompletedBacktest(state, part, name)
    return
  }
  if (failed(part)) state.failedStages.add("backtested")
}

function observeRecovery(state: ObserveState, part: Record<string, any>, scenario: HeadlessScenarioV1): void {
  const metadata = metadataOf(part)
  const output = outputOf(part)
  if (!failed(part) && metadata.recovered !== true) return
  const kind = String(metadata.kind ?? `${part.tool}_${failed(part) ? "error" : "recovery"}`)
  state.recoveries.push({
    kind,
    allowed: scenario.allowedRecoveries.includes(kind),
    detail: failed(part) ? String(part.state?.error ?? "tool error") : output.slice(0, 500),
  })
}

function observeToolPart(state: ObserveState, part: Record<string, any>, scenario: HeadlessScenarioV1): void {
  state.toolCalls++
  if (part.tool === "finny_workspace_prepare") observePreparePart(state, part)
  if (part.tool === "task") observeTaskPart(state, part)
  if (part.tool === "finny_algorithm_save") observeSavePart(state, part)
  if (part.tool === "finny_algorithm_validate") observeValidatePart(state, part)
  if (part.tool === "finny_backtest" || part.tool === "finny_backtest_run") observeBacktestPart(state, part)
  observeRecovery(state, part, scenario)
}

function observeEvent(state: ObserveState, event: JsonEvent, scenario: HeadlessScenarioV1): void {
  if (event.type === "step_finish") state.modelTurns++
  if (event.type === "text" && typeof event.part?.text === "string") state.finalTexts.push(event.part.text)
  if (event.type === "error") {
    const message = typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {})
    state.errors.push({ kind: "session_error", message })
  }
  const part = toolPart(event)
  if (part) observeToolPart(state, part, scenario)
}

function enforceStageRequirements(state: ObserveState, scenario: HeadlessScenarioV1): HarnessObservation["stages"] {
  const stages: HarnessObservation["stages"] = {}
  for (const stage of scenario.requiredStages) {
    stages[stage] = state.completedStages.has(stage)
      ? "completed"
      : state.failedStages.has(stage)
        ? "failed"
        : "missing"
    if (stages[stage] !== "completed") {
      addViolation(state.violations, "required_stage_missing", `Required stage ${stage} did not complete.`, {
        stage,
        observed: stages[stage],
      })
    }
  }
  return stages
}

function enforceCountLimits(state: ObserveState, scenario: HeadlessScenarioV1): void {
  if (state.toolCalls > scenario.limits.toolCalls) {
    addViolation(
      state.violations,
      "tool_call_limit",
      `Observed ${state.toolCalls} tool calls; limit is ${scenario.limits.toolCalls}.`,
    )
  }
  if (state.modelTurns > scenario.limits.modelTurns) {
    addViolation(
      state.violations,
      "model_turn_limit",
      `Observed ${state.modelTurns} model turns; limit is ${scenario.limits.modelTurns}.`,
    )
  }
  if (state.subagents.size > scenario.limits.subagents) {
    addViolation(
      state.violations,
      "subagent_limit",
      `Observed ${state.subagents.size} subagents; limit is ${scenario.limits.subagents}.`,
    )
  }
  if (state.algorithms.size > scenario.artifactPolicy.maxAlgorithms) {
    addViolation(
      state.violations,
      "algorithm_limit",
      `Observed ${state.algorithms.size} algorithms; limit is ${scenario.artifactPolicy.maxAlgorithms}.`,
      { algorithms: [...state.algorithms] },
    )
  }
  for (const [algorithm, versions] of Object.entries(state.versionsByAlgorithm)) {
    if (versions > scenario.artifactPolicy.maxVersionsPerAlgorithm) {
      addViolation(
        state.violations,
        "version_limit",
        `${algorithm} produced ${versions} versions; limit is ${scenario.artifactPolicy.maxVersionsPerAlgorithm}.`,
      )
    }
  }
  if (state.backtests > scenario.artifactPolicy.maxBacktests) {
    addViolation(
      state.violations,
      "backtest_limit",
      `Observed ${state.backtests} backtests; limit is ${scenario.artifactPolicy.maxBacktests}.`,
    )
  }
}

function enforceIdentityPresence(state: ObserveState): void {
  const identitySources: Array<[string, IdentitySets, Array<keyof IdentitySets>]> = [
    [
      "request_bound",
      state.preparedIdentity,
      ["symbols", "assetClasses", "intervals", "startDates", "endDates", "strategyFamilies"],
    ],
    [
      "candidate_saved",
      state.candidateIdentity,
      ["symbols", "assetClasses", "intervals", "startDates", "endDates", "strategyFamilies"],
    ],
    ["backtested", state.backtestIdentity, ["intervals", "startDates", "endDates"]],
  ]
  for (const [stage, source, required] of identitySources) {
    if (!state.completedStages.has(stage as HarnessStageName)) continue
    for (const field of required) {
      if (source[field].size === 0) {
        addViolation(
          state.violations,
          "request_identity_missing",
          `Completed stage ${stage} is missing structured ${field}.`,
          { stage, field },
        )
      }
    }
  }
}

function enforceExactIdentity(state: ObserveState, scenario: HeadlessScenarioV1, observed: IdentitySets): void {
  const exactFields: Array<{ code: string; field: keyof IdentitySets; expected: string[] }> = [
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
  const hasIdentityStage =
    state.completedStages.has("request_bound") ||
    state.completedStages.has("candidate_saved") ||
    state.completedStages.has("backtested")
  if (!hasIdentityStage) return
  for (const { code, field, expected } of exactFields) {
    const actual = [...observed[field]].sort()
    const wanted = [...new Set(expected)].sort()
    if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
      addViolation(state.violations, code, `Observed ${field} do not exactly match the scenario request.`, {
        expected: wanted,
        observed: actual,
      })
    }
  }
}

function enforceStrategyFamilies(state: ObserveState, scenario: HeadlessScenarioV1): void {
  const allowedFamilies = new Set(scenario.request.strategyFamilies.map(normalize))
  if (state.completedStages.has("request_bound")) {
    const requestedFamilies = [...state.preparedIdentity.strategyFamilies]
    if (requestedFamilies.length === 0 || requestedFamilies.some((family) => !allowedFamilies.has(family))) {
      addViolation(
        state.violations,
        "request_strategy_family_mismatch",
        "Bound request does not declare an allowed strategy family.",
        { allowed: [...allowedFamilies], observed: requestedFamilies },
      )
    }
  }
  if (!state.completedStages.has("candidate_saved")) return
  const candidateFamilies = [...state.candidateIdentity.strategyFamilies]
  if (candidateFamilies.length === 0) {
    addViolation(
      state.violations,
      "strategy_family_missing",
      "Saved candidate has no structured strategy family declaration.",
    )
    return
  }
  if (candidateFamilies.some((family) => !allowedFamilies.has(family))) {
    addViolation(
      state.violations,
      "strategy_family_drift",
      "Saved candidate declares a strategy family outside the scenario.",
      { allowed: [...allowedFamilies], observed: candidateFamilies },
    )
  }
}

function enforceFinalFields(state: ObserveState, scenario: HeadlessScenarioV1, finalText: string): void {
  const lowered = finalText.toLowerCase()
  for (const field of scenario.requiredFinalFields) {
    if (lowered.includes(field.toLowerCase())) continue
    addViolation(state.violations, "final_field_missing", `Final response is missing required field ${field}.`, {
      field,
    })
  }
}

function enforceRecoveries(state: ObserveState): void {
  for (const recovery of state.recoveries) {
    if (recovery.allowed) continue
    addViolation(state.violations, "unapproved_recovery", `Recovery ${recovery.kind} is not allowed by the scenario.`)
  }
}

function enforceFinalAndRecoveries(state: ObserveState, scenario: HeadlessScenarioV1, finalText: string): void {
  enforceFinalFields(state, scenario, finalText)
  enforceRecoveries(state)
}

export function observeRun(events: JsonEvent[], scenario: HeadlessScenarioV1): HarnessObservation {
  const state = createObserveState()
  for (const event of events) observeEvent(state, event, scenario)

  const stages = enforceStageRequirements(state, scenario)
  enforceCountLimits(state, scenario)
  enforceIdentityPresence(state)
  const observedIdentity = mergeIdentity(state.preparedIdentity, state.candidateIdentity, state.backtestIdentity)
  enforceExactIdentity(state, scenario, observedIdentity)
  enforceStrategyFamilies(state, scenario)
  const finalText = state.finalTexts.at(-1) ?? ""
  enforceFinalAndRecoveries(state, scenario, finalText)

  return {
    mainSession: events.find((event) => typeof event.sessionID === "string")?.sessionID,
    toolCalls: state.toolCalls,
    modelTurns: state.modelTurns,
    subagents: [...state.subagents.values()],
    algorithms: [...state.algorithms],
    versionsByAlgorithm: state.versionsByAlgorithm,
    backtests: state.backtests,
    completedBacktests: state.completedBacktests,
    savedCandidates: state.savedCandidates,
    backtestRuns: state.backtestRuns,
    requestIdentity: {
      ...serializeIdentity(observedIdentity),
      sources: {
        request_bound: serializeIdentity(state.preparedIdentity),
        candidate_saved: serializeIdentity(state.candidateIdentity),
        backtested: serializeIdentity(state.backtestIdentity),
      },
    },
    stages,
    finalText,
    recoveries: state.recoveries,
    errors: state.errors,
    violations: state.violations,
  }
}

function evidenceInvalid(input: {
  observabilityRequired?: boolean
  observabilityAvailable?: boolean
  integrityErrors?: string[]
}): boolean {
  if (input.observabilityRequired && !input.observabilityAvailable) return true
  return Boolean(input.integrityErrors?.length)
}

function executionFailed(input: { childExitCode?: number; observation: HarnessObservation }): boolean {
  if ((input.childExitCode ?? 0) !== 0) return true
  return input.observation.errors.length > 0
}

function terminalStatus(input: {
  interrupted?: boolean
  internalError?: boolean
  preflightFailed?: boolean
}): { status: HarnessStatus; exitCode: number } | undefined {
  if (input.interrupted) return { status: "interrupted", exitCode: 130 }
  if (input.internalError) return { status: "internal_error", exitCode: 70 }
  if (input.preflightFailed) return { status: "preflight_failed", exitCode: 3 }
}

function runtimeStatus(input: {
  timedOut?: boolean
  childExitCode?: number
  observation: HarnessObservation
}): { status: HarnessStatus; exitCode: number } | undefined {
  if (input.timedOut) return { status: "timed_out", exitCode: 4 }
  if (executionFailed(input)) return { status: "execution_failed", exitCode: 4 }
}

function contractStatus(observation: HarnessObservation): { status: HarnessStatus; exitCode: number } {
  if (observation.violations.length > 0) return { status: "contract_failed", exitCode: 2 }
  if (observation.recoveries.length > 0) return { status: "completed_with_recoveries", exitCode: 0 }
  return { status: "completed", exitCode: 0 }
}

export function classifyOutcome(input: {
  preflightFailed?: boolean
  timedOut?: boolean
  interrupted?: boolean
  internalError?: boolean
  childExitCode?: number
  integrityErrors?: string[]
  observabilityRequired?: boolean
  observabilityAvailable?: boolean
  observation: HarnessObservation
}): { status: HarnessStatus; exitCode: number } {
  const terminal = terminalStatus(input)
  if (terminal) return terminal
  if (evidenceInvalid(input)) return { status: "evidence_invalid", exitCode: 5 }
  const runtime = runtimeStatus(input)
  if (runtime) return runtime
  return contractStatus(input.observation)
}
