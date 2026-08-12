import { z } from "zod"

export const HarnessStageName = z.enum([
  "request_bound",
  "evidence_ready",
  "candidate_saved",
  "validated",
  "backtested",
  "reviewable",
  "experiment_planned",
  "holdout_approved",
  "qualified",
  "review_packet_ready",
])
export type HarnessStageName = z.infer<typeof HarnessStageName>

export const HeadlessScenarioV1 = z.object({
  schemaVersion: z.literal("1.0.0"),
  id: z.string().min(1),
  prompt: z.string().min(1),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limits: z.object({
    wallTimeMs: z.number().int().positive(),
    modelTurns: z.number().int().positive(),
    toolCalls: z.number().int().positive(),
    subagents: z.number().int().nonnegative(),
  }),
  request: z.object({
    symbols: z.array(z.string().min(1)).min(1),
    assetClass: z.string().min(1),
    interval: z.string().min(1),
    strategyFamilies: z.array(z.string().min(1)).min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  artifactPolicy: z.object({
    maxAlgorithms: z.number().int().positive(),
    maxVersionsPerAlgorithm: z.number().int().positive(),
    maxBacktests: z.number().int().positive(),
  }),
  requiredStages: z.array(HarnessStageName),
  requiredFinalFields: z.array(z.string()),
  allowedRecoveries: z.array(z.string()),
  observabilityRequired: z.boolean(),
  approvals: z.object({ sealedHoldout: z.boolean() }).optional(),
})
export type HeadlessScenarioV1 = z.infer<typeof HeadlessScenarioV1>

export const HarnessStatus = z.enum([
  "completed",
  "completed_with_recoveries",
  "contract_failed",
  "preflight_failed",
  "execution_failed",
  "timed_out",
  "evidence_invalid",
  "interrupted",
  "internal_error",
])
export type HarnessStatus = z.infer<typeof HarnessStatus>

export const FixtureScriptMode = z.enum(["negative", "strategy_drift", "midstream_failure", "positive_qualification"])
export type FixtureScriptMode = z.infer<typeof FixtureScriptMode>

export const ContractViolation = z.object({
  code: z.string(),
  message: z.string(),
  evidence: z.record(z.string(), z.unknown()).optional(),
})
export type ContractViolation = z.infer<typeof ContractViolation>

// @codescene(disable-all) Manifest shape is intentionally explicit for the published contract.
export const RunManifestV1 = z.object({
  schemaVersion: z.literal("1.0.0"),
  runId: z.string(),
  scenarioId: z.string(),
  status: HarnessStatus,
  exitCode: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  source: z.object({
    ref: z.string(),
    commit: z.string(),
    targetTreeHash: z.string().min(1),
    treeState: z.literal("clean"),
    preparation: z.enum(["detached_worktree_frozen_install", "test_current_checkout"]),
    bunLockSha256: z.string(),
    evaluatorSourceSha256: z.string().length(64),
    evaluatorEntrypointSha256: z.string().length(64),
    scenarioSha256: z.string().length(64),
  }),
  runtime: z.object({
    os: z.string(),
    arch: z.string(),
    bunVersion: z.string(),
    pythonVersion: z.string().optional(),
    uvVersion: z.string().optional(),
    pythonPackagesSha256: z.string().length(64).optional(),
    pythonPackagesPreflightSha256: z.string().length(64).optional(),
    pythonLockSha256: z.string().length(64).optional(),
    pythonRuntimeManifestSha256: z.string().length(64).optional(),
  }),
  model: z.object({
    id: z.string(),
    agent: z.string(),
    fixtureMode: FixtureScriptMode.optional(),
    requestCount: z.number().int().nonnegative().optional(),
    configSha256: z.string().length(64).optional(),
    scriptSha256: z.string().length(64).optional(),
  }),
  isolation: z.object({
    namespace: z.string(),
    reusedState: z.literal(false),
    finnyHome: z.string(),
    database: z.string(),
    xdgData: z.string(),
    xdgState: z.string(),
    xdgCache: z.string(),
    xdgConfig: z.string(),
    phoenixProject: z.string(),
    ports: z.record(z.string(), z.number().int().positive()),
    cleanupStatus: z.enum(["completed", "failed"]),
  }),
  attempts: z.array(
    z.object({
      index: z.number().int().positive(),
      phase: z.enum(["preflight", "execution"]),
      status: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      exitCode: z.number().int().optional(),
      error: z.string().optional(),
    }),
  ),
  sessions: z.object({
    main: z.string().optional(),
    subagents: z.array(z.object({ id: z.string(), type: z.string().optional() })),
  }),
  stages: z.record(z.string(), z.enum(["completed", "missing", "failed"])),
  requestAdherence: z.object({
    expected: z.record(z.string(), z.unknown()),
    observed: z.record(z.string(), z.unknown()),
    violations: z.array(ContractViolation),
  }),
  strategyResults: z.array(z.record(z.string(), z.unknown())),
  recoveries: z.array(z.object({ kind: z.string(), allowed: z.boolean(), detail: z.string().optional() })),
  errors: z.array(z.object({ kind: z.string(), message: z.string() })),
  observability: z.object({
    required: z.boolean(),
    project: z.string(),
    sessionId: z.string().optional(),
    traceIds: z.array(z.string()),
    spanCount: z.number().int().nonnegative(),
    unattributedSpanCount: z.number().int().nonnegative(),
    paginationComplete: z.boolean(),
    completionSpanFound: z.boolean(),
    flush: z.enum(["completed", "timed_out", "failed", "not_run"]),
    grade: z.enum(["valid", "critical", "invalid", "not_run"]),
  }),
  semanticHashes: z.object({
    source: z.string().length(64),
    fixtureData: z.string().length(64).optional(),
    normalizedEvents: z.string().length(64),
    contract: z.string().length(64),
    strategyResults: z.string().length(64),
  }),
  artifacts: z.array(
    z.object({
      path: z.string(),
      sha256: z.string(),
      size: z.number().int().nonnegative(),
      kind: z.string(),
    }),
  ),
  integrity: z.object({
    artifactMerkleRoot: z.string(),
    checksumAlgorithm: z.literal("sha256"),
  }),
})
export type RunManifestV1 = z.infer<typeof RunManifestV1>

export type HeadlessHarnessOptions = {
  ref: string
  /** Scenario object or path to a scenario JSON file. */
  scenarioPath: string | HeadlessScenarioV1
  model: string
  agent: string
  outputDir: string
  timeoutMs?: number
  repository?: string
  /** @internal Test-only escape hatch. Production callers always use the default detached frozen source. */
  testOnlyUseCurrentSource?: boolean
  fixtureMode?: FixtureScriptMode
  collectorEndpoint?: string
  /** Internal test seam: paths are checked before any fixture model server starts. */
  requiredDependencyPaths?: string[]
}

export type HeadlessHarnessResult = {
  manifest: RunManifestV1
  bundlePath: string
  exitCode: number
}
