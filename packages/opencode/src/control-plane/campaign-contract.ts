import { Schema } from "effect"

export const CandidateInput = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  parentCandidateID: Schema.optional(Schema.String),
})

export const Budget = Schema.Struct({
  maxSessions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  maxTurns: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  maxTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  maxCost: Schema.Finite.check(Schema.isGreaterThan(0)),
  maxWallClockMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
})

export const StopRules = Schema.Struct({
  maxRounds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  targetSharpe: Schema.optional(Schema.Finite),
  maxDrawdown: Schema.optional(Schema.Finite),
})

export const CreateInput = Schema.Struct({
  operationID: Schema.String,
  goal: Schema.String,
  candidates: Schema.NonEmptyArray(CandidateInput),
  budget: Budget,
  stop: StopRules,
  agent: Schema.optional(Schema.String),
})

export const ContinueInput = Schema.Struct({
  operationID: Schema.String,
  candidateID: Schema.String,
  prompt: Schema.String,
})

export const ArtifactInput = Schema.Struct({
  operationID: Schema.String,
  candidateID: Schema.String,
  manifestID: Schema.String,
})

export const AdvanceInput = Schema.Struct({
  operationID: Schema.String,
  improvementPrompt: Schema.optional(Schema.String),
})

export const EventQuery = Schema.Struct({
  after: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const WaitQuery = Schema.Struct({
  after: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  timeoutMs: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(30_000)),
  ),
})
