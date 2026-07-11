import crypto from "node:crypto"
import {
  appendEvent,
  experimentRootDir,
  holdoutAlreadyOpened,
  readTrialEvents,
  recordHoldoutAccess,
} from "./experiment-store"
import { withExperimentLock } from "./experiment-lock"
import { assertDataSnapshot } from "./experiment-snapshot"
import { resolveExperimentSpec, sha256, validatePhase } from "./experiment-spec"
import {
  ExperimentContractError,
  type BeginTrialInput,
  type CompleteTrialInput,
  type ExperimentPhase,
  type ExperimentReference,
  type ExperimentSpec,
  type TrialEvent,
} from "./experiment-types"

export * from "./experiment-types"
export { experimentRootDir, readTrialEvents }
export { normalizeHypothesis, sha256 } from "./experiment-spec"

interface TrialSummary {
  started: number
  priorConsecutiveFailures: number
}

function summarizeTrials(events: TrialEvent[]): TrialSummary {
  const started = events.filter((event) => event.event === "started").length
  const completions = events.filter((event) => event.event === "completed")
  let priorConsecutiveFailures = 0
  for (const event of completions.toReversed()) {
    if (event.outcome === "passed") break
    if (event.outcome === "failed") priorConsecutiveFailures++
  }
  return { started, priorConsecutiveFailures }
}

function assertOptimizationBudget(spec: ExperimentSpec, phase: ExperimentPhase, started: number) {
  if (phase === "confirmatory" || started < spec.optimizationBudget) return
  throw new ExperimentContractError(
    `experiment optimization budget exhausted (${started}/${spec.optimizationBudget} trials)`,
  )
}

async function assertHoldoutAvailable(experimentId: string, phase: ExperimentPhase) {
  if (phase !== "confirmatory" || !(await holdoutAlreadyOpened({ experimentId }))) return
  throw new ExperimentContractError(
    "the sealed holdout has already been opened for this experiment; create a descendant lineage for any new test window",
  )
}

function referenceFor(
  input: BeginTrialInput,
  spec: ExperimentSpec,
  phase: ExperimentPhase,
  trialNumber: number,
): ExperimentReference {
  return {
    experimentId: spec.experimentId,
    experimentSpecVersion: spec.version,
    experimentSpecHash: spec.specHash,
    trialId: crypto.randomUUID(),
    trialNumber,
    phase,
    qualityGates: spec.qualityGates,
    dataSnapshot: spec.dataSnapshot,
    codeHash: sha256(input.algorithm.code),
    configHash: sha256(input.algorithm.config ?? ""),
  }
}

function startedEvent(input: BeginTrialInput, reference: ExperimentReference): TrialEvent {
  return {
    schemaVersion: 1,
    event: "started",
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    algorithmId: input.algorithm.algorithmId,
    algorithmName: input.algorithm.name,
    algorithmVersion: input.algorithm.version,
    startDate: input.startDate,
    endDate: input.endDate,
    ...reference,
  }
}

export async function beginTrial(input: BeginTrialInput): Promise<{
  spec: ExperimentSpec
  reference: ExperimentReference
  priorConsecutiveFailures: number
}> {
  const spec = await resolveExperimentSpec(input)
  return withExperimentLock(spec.experimentId, async () => {
    const phase = validatePhase(input, spec)
    await assertHoldoutAvailable(spec.experimentId, phase)
    const summary = summarizeTrials(await readTrialEvents({ experimentId: spec.experimentId }))
    assertOptimizationBudget(spec, phase, summary.started)
    const reference = referenceFor(input, spec, phase, summary.started + 1)
    const event = startedEvent(input, reference)
    if (phase === "confirmatory") {
      await recordHoldoutAccess({ spec, event, reason: input.experiment!.approvalReason! })
    }
    await appendEvent(event)
    return { spec, reference, priorConsecutiveFailures: summary.priorConsecutiveFailures }
  })
}

function completedEvent(input: CompleteTrialInput): TrialEvent {
  return {
    schemaVersion: 1,
    event: "completed",
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    algorithmId: input.algorithm.algorithmId,
    algorithmName: input.algorithm.name,
    algorithmVersion: input.algorithm.version,
    outcome: input.outcome,
    runId: input.runId,
    actualDataHash: input.actualDataHash,
    details: input.details,
    ...input.reference,
  }
}

export async function completeTrial(input: CompleteTrialInput) {
  await withExperimentLock(input.reference.experimentId, async () => {
    await assertDataSnapshot({
      experimentId: input.reference.experimentId,
      expectedDataSnapshot: input.reference.dataSnapshot,
      actualDataHash: input.actualDataHash,
    })
    await appendEvent(completedEvent(input))
  })
}

export * as ExperimentLedger from "./experiment"
