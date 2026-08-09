import { Schema } from "effect"

export const AgentControlStatusV1 = Schema.Literals(["busy", "idle", "active", "error", "blocked"])

export const AgentControlV1 = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.String),
  directory: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  modelRef: Schema.optional(Schema.String),
  status: AgentControlStatusV1,
  currentActivity: Schema.optional(Schema.String),
  elapsedMs: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Number),
  childCount: Schema.Number,
  taskCount: Schema.Number,
  pendingQuestionCount: Schema.Number,
  pendingPermissionCount: Schema.Number,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AgentControlV1" })

export const TaskControlV1 = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  subagentType: Schema.String,
  mode: Schema.String,
  status: Schema.String,
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
  resultSummary: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "TaskControlV1" })

export const CrucibleWorkflowControlV1 = Schema.Struct({
  workflowId: Schema.String,
  sessionId: Schema.String,
  workspaceSlug: Schema.String,
  stage: Schema.String,
  status: Schema.String,
  phase: Schema.String,
  revision: Schema.Number,
  requestVersion: Schema.Number,
  candidate: Schema.optional(Schema.Unknown),
  backtest: Schema.optional(Schema.Unknown),
  blocker: Schema.optional(Schema.Unknown),
  terminal: Schema.optional(Schema.Unknown),
  updatedAt: Schema.Number,
}).annotate({ identifier: "CrucibleWorkflowControlV1" })

export const CrucibleEventControlV1 = Schema.Struct({
  seq: Schema.Number,
  type: Schema.String,
  occurredAt: Schema.Number,
  sourceKind: Schema.String,
  summary: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "CrucibleEventControlV1" })

export const CrucibleStage = Schema.Literals([
  "data",
  "base",
  "walk_forward",
  "monte_carlo",
  "regimes",
  "consistency",
  "alpha_decay",
  "verdict",
  "durability",
  "review_packet",
])

export const CrucibleStageObservationControlV1 = Schema.Struct({
  stage: CrucibleStage,
  status: Schema.Literals(["started", "checkpoint", "completed", "blocked", "failed"]),
  message: Schema.optional(Schema.String),
  artifactId: Schema.optional(Schema.String),
}).annotate({ identifier: "CrucibleStageObservationControlV1" })

export const CampaignControlV1 = Schema.Struct({
  id: Schema.String,
  goal: Schema.String,
  agent: Schema.String,
  status: Schema.String,
  rounds: Schema.Number,
  candidateCount: Schema.Number,
  eventsCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "CampaignControlV1" })

export const DomainHealthControlV1 = Schema.Struct({
  domain: Schema.Literals(["agents", "crucible", "campaign"]),
  status: Schema.Literals(["fresh", "stale", "unavailable"]),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "DomainHealthControlV1" })

export const ControlSnapshotV1 = Schema.Struct({
  schema: Schema.Literal("finny.control_snapshot"),
  version: Schema.Literal(1),
  capturedAt: Schema.String,
  agents: Schema.Array(AgentControlV1),
  tasks: Schema.Array(TaskControlV1),
  crucible: Schema.Array(CrucibleWorkflowControlV1),
  campaigns: Schema.Array(CampaignControlV1),
  health: Schema.Array(DomainHealthControlV1),
}).annotate({ identifier: "ControlSnapshotV1" })

export const IdempotencyOperationV1 = Schema.Struct({
  operationID: Schema.String,
  requestHash: Schema.String,
}).annotate({ identifier: "IdempotencyOperationV1" })

export const ControlPromptV1 = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
  delivery: Schema.Literals(["steer", "queue"]),
  operationID: Schema.String,
  requestHash: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
}).annotate({ identifier: "ControlPromptV1" })

export const ControlCreateSessionV1 = Schema.Struct({
  operationID: Schema.String,
  requestHash: Schema.String,
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "ControlCreateSessionV1" })

export const ControlAbortV1 = Schema.Struct({
  sessionID: Schema.String,
  operationID: Schema.String,
  requestHash: Schema.String,
}).annotate({ identifier: "ControlAbortV1" })

export const CommandReceiptV1 = Schema.Struct({
  operationID: Schema.String,
  accepted: Schema.Boolean,
  alreadyHandled: Schema.optional(Schema.Boolean),
  sessionID: Schema.optional(Schema.String),
  workflowID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "CommandReceiptV1" })

export type AgentControlV1 = typeof AgentControlV1.Type
export type TaskControlV1 = typeof TaskControlV1.Type
export type CrucibleWorkflowControlV1 = typeof CrucibleWorkflowControlV1.Type
export type CrucibleEventControlV1 = typeof CrucibleEventControlV1.Type
export type CampaignControlV1 = typeof CampaignControlV1.Type
export type DomainHealthControlV1 = typeof DomainHealthControlV1.Type
export type ControlSnapshotV1 = typeof ControlSnapshotV1.Type
export type ControlPromptV1 = typeof ControlPromptV1.Type
export type ControlCreateSessionV1 = typeof ControlCreateSessionV1.Type
export type ControlAbortV1 = typeof ControlAbortV1.Type
export type CommandReceiptV1 = typeof CommandReceiptV1.Type

export * as ControlContracts from "./control-contracts"
