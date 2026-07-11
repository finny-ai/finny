export type ExperimentPhase = "exploratory" | "validation" | "confirmatory"

export interface ExperimentQualityGates {
  minDeflatedSharpe: number
  minProbabilisticSharpe: number
  minOosCoverage: number
  minTrades: number
  requireCostSensitivity: boolean
}

export interface ExperimentBoundaries {
  trainStart: string
  trainEnd: string
  validationEnd: string
  testEnd: string
}

export interface ExperimentSpec {
  schemaVersion: 1
  experimentId: string
  version: number
  parentExperimentId?: string
  hypothesis: string
  hypothesisKey: string
  falsificationCriteria: string
  universe: string[]
  interval: string
  dataSnapshot: string
  corporateActionPolicy: string
  costs: string
  featureTiming: string
  executionSemantics: string
  boundaries?: ExperimentBoundaries
  permittedSearchSpace: string
  optimizationBudget: number
  primaryMetric: string
  riskConstraints: string
  benchmark: string
  qualityGates: ExperimentQualityGates
  sealedHoldout: boolean
  createdAt: string
  specHash: string
}

export interface ExperimentInput {
  experimentId?: string
  parentExperimentId?: string
  hypothesis?: string
  falsificationCriteria?: string
  dataSnapshot?: string
  corporateActionPolicy?: string
  costs?: string
  featureTiming?: string
  executionSemantics?: string
  boundaries?: ExperimentBoundaries
  permittedSearchSpace?: string
  optimizationBudget?: number
  primaryMetric?: string
  riskConstraints?: string
  benchmark?: string
  qualityGates?: Partial<ExperimentQualityGates>
  phase?: ExperimentPhase
  holdoutApproved?: boolean
  approvalReason?: string
}

export interface ExperimentReference {
  experimentId: string
  experimentSpecVersion: number
  experimentSpecHash: string
  trialId: string
  trialNumber: number
  phase: ExperimentPhase
  qualityGates: ExperimentQualityGates
  dataSnapshot: string
  codeHash: string
  configHash: string
}

export interface TrialEvent extends ExperimentReference {
  schemaVersion: 1
  event: "started" | "completed"
  timestamp: string
  sessionId: string
  algorithmId: string
  algorithmName: string
  algorithmVersion: number
  startDate?: string
  endDate?: string
  outcome?: "passed" | "failed" | "blocked"
  runId?: string
  actualDataHash?: string
  details?: string
}

export interface TrialAlgorithm {
  algorithmId: string
  name: string
  version: number
  code: string
  config?: string
}

export interface BeginTrialInput {
  algorithm: TrialAlgorithm
  interval: string
  startDate?: string
  endDate?: string
  sessionId: string
  experiment?: ExperimentInput
}

export interface CompleteTrialInput {
  reference: ExperimentReference
  sessionId: string
  algorithm: Pick<TrialAlgorithm, "algorithmId" | "name" | "version">
  outcome: "passed" | "failed" | "blocked"
  runId?: string
  actualDataHash?: string
  details?: string
}

export class ExperimentContractError extends Error {}
