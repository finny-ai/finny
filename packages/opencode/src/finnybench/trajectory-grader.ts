export type TerminalClass =
  | "success"
  | "clarification"
  | "blocked_provider"
  | "blocked_unavailable_evidence"
  | "blocked_harness"
  | "failed_model"
  | "cancelled"

export type FailureOrigin = "none" | "model" | "provider" | "harness" | "evidence"
export type Dimension = "terminal" | "harness" | "strategy" | "budget" | "reproducibility"

export interface TrajectoryAssertion {
  kind: string
  [key: string]: unknown
}

export interface ScenarioContract {
  id: string
  tracks: number[]
  prompt_sha256: string
  expected_terminal: TerminalClass
  subset: "smoke" | "full"
  assertions: TrajectoryAssertion[]
  budgets: { latency_ms: number; estimated_cost_usd: number }
}

export interface SuiteContract {
  schema: "finnybench.trajectory-suite.v1"
  providers: Array<{ id: string; family: "gemini" | "openai-compatible"; config_sha256: string }>
  scenarios: ScenarioContract[]
}

export interface Trajectory {
  schema: "finnybench.trajectory.v1"
  scenario_id: string
  run_id: string
  pins: {
    prompt_sha256: string
    model: string
    provider: string
    provider_config_sha256: string
    data_snapshot_sha256: string
    harness_revision: string
  }
  terminal: { class: TerminalClass; summary: string }
  identity: Array<{
    source: string
    symbol: string
    interval: string
    asset_class: string
    algorithm_name?: string
  }>
  evidence: Array<{
    kind: string
    status: string
    provenance?: string[]
    event_time?: string
    published_at?: string
    retrieved_at?: string
    fabricated_metrics?: boolean
  }>
  tool_calls: Array<{
    name: string
    status: string
    repeated_task_key?: string
    output?: string
  }>
  children: Array<{ id: string; status: string; tokens: number }>
  usage: {
    input_tokens: number
    cached_input_tokens: number
    reasoning_tokens: number
    output_tokens: number
    latency_ms: number
    estimated_cost_usd: number
  }
  traces: Array<{
    trace_id: string
    span_id: string
    parent_span_id?: string
    name: string
    payload?: string
  }>
  strategy_quality?: {
    valid_backtest: boolean
    leakage_test: boolean
    signals_lagged: boolean
    decision_execution_separated: boolean
    robustness_checks: string[]
    annualization_periods?: number
    packaging_valid?: boolean
    quality_evidence_class?: "synthetic_pinned" | "provider_backed_pinned"
    repeat?: number
    strategy_sharpe?: number
    strategy_total_return?: number
    benchmark_sharpe?: number
    benchmark_total_return?: number
    exploratory_gate_passed?: boolean
    closed_trades?: number
  }
  security?: { canary: string; allowlisted_fields: string[]; observed: Array<{ field: string; value: string }> }
  control_file?: { before_sha256: string; after_sha256: string }
  discovery?: { advertised_provider_resolved: boolean; host_path_probes: number }
  storage?: { session_database: string; lifecycle_databases: string[]; lifecycle_joinable: boolean }
  experiment?: { expected_trials: number; ledger_increment: number; holdout_peek_rejected: boolean }
  artifacts?: Array<{ path: string; kind: string; valid: boolean; metadata?: Record<string, unknown> }>
  route?: { requested_agent: string; resolved_agent?: string }
}

export interface AssertionResult {
  assertion: string
  dimension: Dimension
  pass: boolean
  detail: string
}

export interface TrajectoryGrade {
  schema: "finnybench.trajectory-grade.v1"
  scenario_id: string
  run_id: string
  provider: string
  model: string
  expected_terminal: TerminalClass
  observed_terminal: TerminalClass
  failure_origin: FailureOrigin
  terminal_pass: boolean
  harness_invariants_pass: boolean
  strategy_quality_pass: boolean | null
  budget_pass: boolean
  reproducible: boolean
  pass: boolean
  assertions: AssertionResult[]
}

const sha256 = /^[a-f0-9]{64}$/
const gitSha = /^[a-f0-9]{40}$/
const identityFields = new Set(["source", "symbol", "interval", "asset_class", "algorithm_name"])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function identityValue(item: Trajectory["identity"][number], field: string): string | undefined {
  if (!identityFields.has(field)) return undefined
  if (field === "source") return item.source
  if (field === "symbol") return item.symbol
  if (field === "interval") return item.interval
  if (field === "asset_class") return item.asset_class
  return item.algorithm_name
}

function isProviderContract(value: unknown): boolean {
  if (!record(value)) return false
  return [
    typeof value.id === "string",
    value.family === "gemini" || value.family === "openai-compatible",
    typeof value.config_sha256 === "string",
  ].every(Boolean)
}

function isScenarioContract(value: unknown): boolean {
  if (!record(value)) return false
  const tracksValid = Array.isArray(value.tracks) && value.tracks.every((issue) => typeof issue === "number")
  const assertionsValid =
    Array.isArray(value.assertions) &&
    value.assertions.every((assertion) => record(assertion) && typeof assertion.kind === "string")
  const budgetValid =
    record(value.budgets) &&
    typeof value.budgets.latency_ms === "number" &&
    typeof value.budgets.estimated_cost_usd === "number"
  return [
    typeof value.id === "string",
    tracksValid,
    typeof value.prompt_sha256 === "string",
    typeof value.expected_terminal === "string",
    value.subset === "smoke" || value.subset === "full",
    assertionsValid,
    budgetValid,
  ].every(Boolean)
}

export function isSuiteContract(value: unknown): value is SuiteContract {
  if (!record(value) || value.schema !== "finnybench.trajectory-suite.v1") return false
  if (!Array.isArray(value.providers) || !Array.isArray(value.scenarios)) return false
  return value.providers.every(isProviderContract) && value.scenarios.every(isScenarioContract)
}

export function isTrajectory(value: unknown): value is Trajectory {
  if (!record(value) || value.schema !== "finnybench.trajectory.v1") return false
  const pinRecord = record(value.pins) ? value.pins : undefined
  const pins =
    pinRecord !== undefined &&
    ["prompt_sha256", "model", "provider", "provider_config_sha256", "data_snapshot_sha256", "harness_revision"].every(
      (key) => typeof pinRecord[key] === "string",
    )
  const terminal =
    record(value.terminal) && typeof value.terminal.class === "string" && typeof value.terminal.summary === "string"
  return [
    typeof value.scenario_id === "string",
    typeof value.run_id === "string",
    pins,
    terminal,
    Array.isArray(value.identity),
    Array.isArray(value.evidence),
    Array.isArray(value.tool_calls),
    Array.isArray(value.children),
    Array.isArray(value.traces),
    record(value.usage),
  ].every(Boolean)
}

function result(assertion: string, dimension: Dimension, pass: boolean, detail: string): AssertionResult {
  return { assertion, dimension, pass, detail }
}

function terminalOrigin(terminal: TerminalClass): FailureOrigin {
  if (terminal === "blocked_provider") return "provider"
  if (terminal === "blocked_unavailable_evidence") return "evidence"
  if (terminal === "blocked_harness") return "harness"
  if (terminal === "failed_model") return "model"
  return "none"
}

function repeats(trajectory: Trajectory): number {
  const counts = new Map<string, number>()
  for (const call of trajectory.tool_calls) {
    if (!call.repeated_task_key) continue
    counts.set(call.repeated_task_key, (counts.get(call.repeated_task_key) ?? 0) + 1)
  }
  return Math.max(0, ...[...counts.values()].map((count) => count - 1))
}

function traceTreeValid(trajectory: Trajectory): boolean {
  if (trajectory.traces.length === 0) return false
  const spanIds = new Set(trajectory.traces.map((span) => span.span_id))
  const traceIds = new Set(trajectory.traces.map((span) => span.trace_id))
  const roots = trajectory.traces.filter((span) => !span.parent_span_id)
  return (
    traceIds.size === 1 &&
    roots.length === 1 &&
    trajectory.traces.every((span) => !span.parent_span_id || spanIds.has(span.parent_span_id))
  )
}

type AssertionEvaluator = (assertion: TrajectoryAssertion, trajectory: Trajectory) => AssertionResult

const assertionEvaluators: Record<string, AssertionEvaluator> = {
  identity_constant: (assertion, trajectory) => {
    const configured = stringList(assertion.fields)
    const fields = configured.length > 0 ? configured : ["symbol", "interval", "asset_class", "algorithm_name"]
    const first = trajectory.identity[0]
    const pass =
      !!first &&
      trajectory.identity.every((item) =>
        fields.every((field) => identityValue(item, field) === identityValue(first, field)),
      )
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "request identity stayed constant" : "request identity drifted",
    )
  },
  identity_equals: (assertion, trajectory) => {
    const field = typeof assertion.field === "string" ? assertion.field : ""
    const expected = assertion.value
    const pass =
      identityFields.has(field) &&
      trajectory.identity.length > 0 &&
      trajectory.identity.every((item) => identityValue(item, field) === expected)
    return result(assertion.kind, "harness", pass, `${field} expected ${String(expected)}`)
  },
  max_evidence_attempts: (assertion, trajectory) => {
    const max = Number(assertion.max)
    const pass = trajectory.evidence.length <= max
    return result(assertion.kind, "harness", pass, `${trajectory.evidence.length}/${max} evidence attempts`)
  },
  no_fabricated_metrics: (assertion, trajectory) => {
    const pass = trajectory.evidence.every((item) => item.fabricated_metrics !== true)
    return result(assertion.kind, "harness", pass, pass ? "no fabricated metrics" : "fabricated metrics observed")
  },
  temporal_alignment: (assertion, trajectory) => {
    const pass = trajectory.evidence.every(
      (item) =>
        !item.published_at || !item.retrieved_at || Date.parse(item.published_at) <= Date.parse(item.retrieved_at),
    )
    return result(
      assertion.kind,
      "strategy",
      pass,
      pass ? "evidence clocks are causal" : "post-retrieval publication observed",
    )
  },
  strategy_leakage_gate: (assertion, trajectory) => {
    const quality = trajectory.strategy_quality
    const pass = !!quality?.leakage_test && quality.signals_lagged && quality.decision_execution_separated
    return result(assertion.kind, "strategy", pass, pass ? "leakage gates passed" : "leakage gate incomplete")
  },
  forbid_tools: (assertion, trajectory) => {
    const forbidden = new Set(stringList(assertion.names))
    const seen = trajectory.tool_calls.filter((call) => forbidden.has(call.name)).map((call) => call.name)
    return result(
      assertion.kind,
      "harness",
      seen.length === 0,
      seen.length === 0 ? "no forbidden tools" : `forbidden tools: ${seen.join(", ")}`,
    )
  },
  provider_failure_before_provisioning: (assertion, trajectory) => {
    const provision = new Set(["finny_workspace_prepare", "task", "finny_algorithm_scaffold"])
    const pass =
      trajectory.terminal.class === "blocked_provider" &&
      trajectory.tool_calls.every((call) => !provision.has(call.name)) &&
      trajectory.children.length === 0
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "provider preflight failed closed" : "provider failure crossed provisioning boundary",
    )
  },
  evidence_result: (assertion, trajectory) => {
    const expected = String(assertion.value)
    const pass = trajectory.evidence.some((item) => item.status === expected)
    return result(assertion.kind, "harness", pass, pass ? `observed ${expected}` : `missing ${expected}`)
  },
  no_orphans: (assertion, trajectory) => {
    const pass = trajectory.children.every((child) => child.status !== "running" && child.tokens > 0)
    return result(assertion.kind, "harness", pass, pass ? "no running or zero-token children" : "orphan child observed")
  },
  secret_canary: (assertion, trajectory) => {
    const security = trajectory.security
    const leaked =
      security?.observed.some(
        (entry) => !security.allowlisted_fields.includes(entry.field) && entry.value.includes(security.canary),
      ) ?? true
    const payloadLeak = trajectory.traces.some((span) =>
      span.payload?.includes(security?.canary ?? "__missing_canary__"),
    )
    const pass = !!security && !leaked && !payloadLeak
    return result(assertion.kind, "harness", pass, pass ? "canary stayed scoped" : "non-allowlisted canary exposure")
  },
  control_file_immutable: (assertion, trajectory) => {
    const pass =
      !!trajectory.control_file && trajectory.control_file.before_sha256 === trajectory.control_file.after_sha256
    return result(assertion.kind, "harness", pass, pass ? "control file hash unchanged" : "control file hash changed")
  },
  skill_discovery: (assertion, trajectory) => {
    const pass = !!trajectory.discovery?.advertised_provider_resolved && trajectory.discovery.host_path_probes === 0
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "advertised provider resolved without host probing" : "provider discovery contract failed",
    )
  },
  artifact_metadata: (assertion, trajectory) => {
    const artifactKind = String(assertion.artifact_kind)
    const key = String(assertion.key)
    const matching = trajectory.artifacts?.filter((artifact) => artifact.kind === artifactKind) ?? []
    const pass = matching.length > 0 && matching.every((artifact) => artifact.metadata?.[key] !== undefined)
    return result(assertion.kind, "harness", pass, pass ? `${key} present` : `${key} missing from ${artifactKind}`)
  },
  mandatory_worker: (assertion, trajectory) => {
    const required = String(assertion.agent)
    const matching = trajectory.children.filter((child) => child.id.startsWith(required))
    const pass = matching.length === 1 && matching[0]?.status !== "running"
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? `one terminal ${required} worker` : `expected one terminal ${required} worker`,
    )
  },
  single_persistence_root: (assertion, trajectory) => {
    const storage = trajectory.storage
    const pass =
      !!storage &&
      storage.lifecycle_joinable &&
      storage.lifecycle_databases.every((database) => database === storage.session_database)
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "session and lifecycle rows share one database" : "split persistence roots",
    )
  },
  holdout_firewall: (assertion, trajectory) => {
    const experiment = trajectory.experiment
    const pass =
      !!experiment && experiment.ledger_increment === experiment.expected_trials && experiment.holdout_peek_rejected
    return result(
      assertion.kind,
      "strategy",
      pass,
      pass ? "trial ledger complete and holdout sealed" : "trial ledger or holdout firewall failed",
    )
  },
  annualization: (assertion, trajectory) => {
    const expected = Number(assertion.periods)
    const actual = trajectory.strategy_quality?.annualization_periods
    return result(
      assertion.kind,
      "strategy",
      actual === expected,
      `annualization expected ${expected}, observed ${String(actual)}`,
    )
  },
  artifact_sequence: (assertion, trajectory) => {
    const required = stringList(assertion.kinds)
    const valid = trajectory.artifacts?.filter((artifact) => artifact.valid).map((artifact) => artifact.kind) ?? []
    let cursor = 0
    for (const item of valid) if (item === required[cursor]) cursor++
    const pass = cursor === required.length && trajectory.strategy_quality?.packaging_valid === true
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "artifact sequence completed" : "artifact sequence or packaging failed",
    )
  },
  agent_route_exact: (assertion, trajectory) => {
    const pass = !!trajectory.route && trajectory.route.requested_agent === trajectory.route.resolved_agent
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "requested agent resolved exactly" : "agent route widened or fell back",
    )
  },
  trace_tree: (assertion, trajectory) => {
    const redactions = stringList(assertion.forbidden_payloads)
    const payloadClean = trajectory.traces.every((span) =>
      redactions.every((secret) => !span.payload?.includes(secret)),
    )
    const pass = traceTreeValid(trajectory) && payloadClean
    return result(
      assertion.kind,
      "harness",
      pass,
      pass ? "one parented redacted trace tree" : "trace topology or redaction failed",
    )
  },
  max_repeated_tasks: (assertion, trajectory) => {
    const max = Number(assertion.max)
    const observed = repeats(trajectory)
    return result(assertion.kind, "harness", observed <= max, `${observed}/${max} repeated tasks`)
  },
  strategy_robustness: (assertion, trajectory) => {
    const required = stringList(assertion.required)
    const observed = new Set(trajectory.strategy_quality?.robustness_checks ?? [])
    const pass = trajectory.strategy_quality?.valid_backtest === true && required.every((item) => observed.has(item))
    return result(
      assertion.kind,
      "strategy",
      pass,
      pass ? "required robustness checks present" : "valid backtest robustness checks incomplete",
    )
  },
}

function assertionResult(assertion: TrajectoryAssertion, trajectory: Trajectory): AssertionResult {
  const evaluator = assertionEvaluators[assertion.kind]
  return (
    evaluator?.(assertion, trajectory) ??
    result(assertion.kind, "harness", false, `unknown assertion kind: ${assertion.kind}`)
  )
}

function reproducibilityResults(
  scenario: ScenarioContract,
  trajectory: Trajectory,
  suite: SuiteContract,
): AssertionResult[] {
  const provider = suite.providers.find((item) => item.id === trajectory.pins.provider)
  return [
    result("schema", "reproducibility", trajectory.schema === "finnybench.trajectory.v1", trajectory.schema),
    result(
      "prompt_pin",
      "reproducibility",
      trajectory.pins.prompt_sha256 === scenario.prompt_sha256 && sha256.test(trajectory.pins.prompt_sha256),
      trajectory.pins.prompt_sha256,
    ),
    result(
      "provider_pin",
      "reproducibility",
      !!provider &&
        provider.config_sha256 === trajectory.pins.provider_config_sha256 &&
        sha256.test(trajectory.pins.provider_config_sha256),
      trajectory.pins.provider,
    ),
    result(
      "data_snapshot_pin",
      "reproducibility",
      sha256.test(trajectory.pins.data_snapshot_sha256),
      trajectory.pins.data_snapshot_sha256,
    ),
    result(
      "harness_revision_pin",
      "reproducibility",
      gitSha.test(trajectory.pins.harness_revision),
      trajectory.pins.harness_revision,
    ),
  ]
}

export function gradeTrajectory(suite: SuiteContract, trajectory: Trajectory): TrajectoryGrade {
  const scenario = suite.scenarios.find((item) => item.id === trajectory.scenario_id)
  if (!scenario) throw new Error(`Unknown FinnyBench trajectory scenario: ${trajectory.scenario_id}`)

  const assertions = [
    ...reproducibilityResults(scenario, trajectory, suite),
    result(
      "terminal_class",
      "terminal",
      trajectory.terminal.class === scenario.expected_terminal,
      `${trajectory.terminal.class} expected ${scenario.expected_terminal}`,
    ),
    result(
      "latency_budget",
      "budget",
      trajectory.usage.latency_ms <= scenario.budgets.latency_ms,
      `${trajectory.usage.latency_ms}/${scenario.budgets.latency_ms} ms`,
    ),
    result(
      "cost_budget",
      "budget",
      trajectory.usage.estimated_cost_usd <= scenario.budgets.estimated_cost_usd,
      `$${trajectory.usage.estimated_cost_usd}/$${scenario.budgets.estimated_cost_usd}`,
    ),
    ...scenario.assertions.map((assertion) => assertionResult(assertion, trajectory)),
  ]
  const passes = (dimension: Dimension) =>
    assertions.filter((item) => item.dimension === dimension).every((item) => item.pass)
  const strategyAssertions = assertions.filter((item) => item.dimension === "strategy")
  const terminalPass = passes("terminal")
  const harnessPass = passes("harness")
  const budgetPass = passes("budget")
  const reproducible = passes("reproducibility")
  const strategyPass = strategyAssertions.length === 0 ? null : strategyAssertions.every((item) => item.pass)
  return {
    schema: "finnybench.trajectory-grade.v1",
    scenario_id: scenario.id,
    run_id: trajectory.run_id,
    provider: trajectory.pins.provider,
    model: trajectory.pins.model,
    expected_terminal: scenario.expected_terminal,
    observed_terminal: trajectory.terminal.class,
    failure_origin: terminalOrigin(trajectory.terminal.class),
    terminal_pass: terminalPass,
    harness_invariants_pass: harnessPass,
    strategy_quality_pass: strategyPass,
    budget_pass: budgetPass,
    reproducible,
    pass: terminalPass && harnessPass && budgetPass && reproducible && strategyPass !== false,
    assertions,
  }
}

function validateProviderFamilies(suite: SuiteContract): string[] {
  return [
    suite.providers.some((provider) => provider.family === "gemini") ? "" : "suite requires a Gemini provider",
    suite.providers.some((provider) => provider.family === "openai-compatible")
      ? ""
      : "suite requires an OpenAI-compatible provider",
  ].filter(Boolean)
}

function validateTrackedIssues(suite: SuiteContract): string[] {
  const trackedIssues = new Set(suite.scenarios.flatMap((scenario) => scenario.tracks))
  const requiredIssues = [67, 129, 130, 131, 132, 133, 134, 135, 136, 140, 141, 142, 143, 144, 145, 146]
  return requiredIssues
    .filter((issue) => !trackedIssues.has(issue))
    .map((issue) => `epic issue #${issue} has no trajectory assertion`)
}

function validateScenario(scenario: ScenarioContract, ids: Set<string>): string[] {
  const errors: string[] = []
  if (ids.has(scenario.id)) errors.push(`duplicate scenario id: ${scenario.id}`)
  ids.add(scenario.id)
  if (!sha256.test(scenario.prompt_sha256))
    errors.push(`${scenario.id}: prompt_sha256 must be 64 lowercase hex characters`)
  if (scenario.tracks.length === 0) errors.push(`${scenario.id}: must track at least one epic issue`)
  if (scenario.assertions.length === 0) errors.push(`${scenario.id}: requires at least one deterministic assertion`)
  if (!(scenario.budgets.latency_ms > 0) || !(scenario.budgets.estimated_cost_usd > 0))
    errors.push(`${scenario.id}: budgets must be positive`)
  return errors
}

function validateProviderHashes(suite: SuiteContract): string[] {
  return suite.providers
    .filter((provider) => !sha256.test(provider.config_sha256))
    .map((provider) => `${provider.id}: invalid config_sha256`)
}

export function validateSuite(suite: SuiteContract): string[] {
  const ids = new Set<string>()
  const scenarioErrors = suite.scenarios.flatMap((scenario) => validateScenario(scenario, ids))
  return [
    ...validateProviderFamilies(suite),
    ...validateTrackedIssues(suite),
    ...scenarioErrors,
    ...validateProviderHashes(suite),
  ]
}
