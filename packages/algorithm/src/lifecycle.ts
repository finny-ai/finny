import { z } from "zod"
import { AlgorithmVersionRefSchema, TenantIdSchema } from "./identity"
import { UtcTimestampSchema } from "./time"

export type LifecycleTransition<State extends string, Action extends string, Guard extends string> = Readonly<{
  from: State
  to: State
  action: Action
  guards: readonly Guard[]
}>

export type LifecycleDefinition<State extends string, Action extends string, Guard extends string> = Readonly<{
  states: readonly State[]
  transitions: readonly LifecycleTransition<State, Action, Guard>[]
}>

export type GuardEvaluation<Guard extends string> = Readonly<Partial<Record<Guard, boolean>>>

export type LegalLifecycleAction<State extends string, Action extends string, Guard extends string> = Readonly<{
  action: Action
  from: State
  to: State
  guards: readonly Guard[]
}>

export type LifecycleTransitionResult<State extends string, Action extends string, Guard extends string> =
  | Readonly<{
      ok: true
      action: Action
      from: State
      to: State
    }>
  | Readonly<{
      ok: false
      reason: "unknown-state"
      state: State
    }>
  | Readonly<{
      ok: false
      reason: "illegal-transition"
      state: State
      action: Action
    }>
  | Readonly<{
      ok: false
      reason: "missing-guards" | "rejected-guards"
      state: State
      action: Action
      guards: readonly Guard[]
    }>

export type LifecycleEngine<State extends string, Action extends string, Guard extends string> = Readonly<{
  legalNextActions(state: State, guards: GuardEvaluation<Guard>): readonly LegalLifecycleAction<State, Action, Guard>[]
  transition(
    state: State,
    action: Action,
    guards: GuardEvaluation<Guard>,
  ): LifecycleTransitionResult<State, Action, Guard>
}>

/**
 * Build a fail-closed engine from declarations. The engine contains no knowledge
 * of algorithm states or guards, so extending a lifecycle only changes its table.
 */
export function createLifecycleEngine<State extends string, Action extends string, Guard extends string>(
  definition: LifecycleDefinition<State, Action, Guard>,
): LifecycleEngine<State, Action, Guard> {
  const declaredStates = [...definition.states]
  const states = new Set<string>(declaredStates)
  const transitionsByState = new Map<State, LifecycleTransition<State, Action, Guard>[]>()
  const actionKeys = new Set<string>()

  if (states.size !== declaredStates.length) throw new Error("lifecycle states must be unique")

  for (const declaration of definition.transitions) {
    const transition = Object.freeze({
      from: declaration.from,
      to: declaration.to,
      action: declaration.action,
      guards: Object.freeze([...declaration.guards]),
    })
    if (!states.has(transition.from) || !states.has(transition.to)) {
      throw new Error(`lifecycle transition ${transition.action} references an unknown state`)
    }
    const actionKey = `${transition.from}\u0000${transition.action}`
    if (actionKeys.has(actionKey)) {
      throw new Error(`lifecycle action ${transition.action} is duplicated for state ${transition.from}`)
    }
    actionKeys.add(actionKey)
    const current = transitionsByState.get(transition.from) ?? []
    current.push(transition)
    transitionsByState.set(transition.from, current)
  }

  function guardFailure(
    transition: LifecycleTransition<State, Action, Guard>,
    guards: GuardEvaluation<Guard>,
  ): { reason: "missing-guards" | "rejected-guards"; guards: readonly Guard[] } | undefined {
    const missing = transition.guards.filter((guard) => guards[guard] === undefined)
    if (missing.length > 0) return { reason: "missing-guards", guards: missing }
    const rejected = transition.guards.filter((guard) => guards[guard] !== true)
    if (rejected.length > 0) return { reason: "rejected-guards", guards: rejected }
    return undefined
  }

  return {
    legalNextActions(state, guards) {
      if (!states.has(state)) return []
      return Object.freeze(
        (transitionsByState.get(state) ?? [])
          .filter((candidate) => guardFailure(candidate, guards) === undefined)
          .map((candidate) =>
            Object.freeze({
              action: candidate.action,
              from: candidate.from,
              to: candidate.to,
              guards: Object.freeze([...candidate.guards]),
            }),
          ),
      )
    },
    transition(state, action, guards) {
      if (!states.has(state)) return { ok: false, reason: "unknown-state", state }
      const candidate = (transitionsByState.get(state) ?? []).find((item) => item.action === action)
      if (!candidate) return { ok: false, reason: "illegal-transition", state, action }
      const failure = guardFailure(candidate, guards)
      if (failure) return { ok: false, state, action, ...failure }
      return { ok: true, action: candidate.action, from: candidate.from, to: candidate.to }
    },
  }
}

export const ALGORITHM_LIFECYCLE_STATES = [
  "draft",
  "validated",
  "backtested",
  "qualified",
  "paper_approved",
  "paper_running",
  "live_eligible",
  "live_running",
  "invalidated",
  "superseded",
  "retired",
] as const
export const AlgorithmLifecycleStateSchema = z.enum(ALGORITHM_LIFECYCLE_STATES)
export type AlgorithmLifecycleState = z.infer<typeof AlgorithmLifecycleStateSchema>

export const ALGORITHM_LIFECYCLE_ACTIONS = [
  "validate",
  "record_strict_backtest",
  "qualify",
  "approve_paper",
  "start_paper",
  "establish_live_eligibility",
  "start_live",
  "invalidate",
  "supersede",
  "retire",
] as const
export const AlgorithmLifecycleActionSchema = z.enum(ALGORITHM_LIFECYCLE_ACTIONS)
export type AlgorithmLifecycleAction = z.infer<typeof AlgorithmLifecycleActionSchema>

export const ALGORITHM_LIFECYCLE_GUARDS = [
  "validation.passed",
  "backtest.strict_verified",
  "qualification.passed",
  "paper.approval_granted",
  "paper.activation_receipt_verified",
  "paper.minimum_ledger_duration_met",
  "paper.drift_within_bounds",
  "runtime.pinned_image_attested",
  "live.gate_passed",
  "backtest.evidence_revoked",
  "version.newer_qualified",
  "deployment.stopped",
] as const
export const AlgorithmLifecycleGuardSchema = z.enum(ALGORITHM_LIFECYCLE_GUARDS)
export type AlgorithmLifecycleGuard = z.infer<typeof AlgorithmLifecycleGuardSchema>

export const ALGORITHM_LIFECYCLE_TRANSITIONS = [
  { from: "draft", to: "validated", action: "validate", guards: ["validation.passed"] },
  {
    from: "validated",
    to: "backtested",
    action: "record_strict_backtest",
    guards: ["backtest.strict_verified"],
  },
  { from: "backtested", to: "qualified", action: "qualify", guards: ["qualification.passed"] },
  {
    from: "qualified",
    to: "paper_approved",
    action: "approve_paper",
    guards: ["paper.approval_granted"],
  },
  {
    from: "paper_approved",
    to: "paper_running",
    action: "start_paper",
    guards: ["paper.activation_receipt_verified"],
  },
  {
    from: "paper_running",
    to: "live_eligible",
    action: "establish_live_eligibility",
    guards: ["paper.minimum_ledger_duration_met", "paper.drift_within_bounds", "runtime.pinned_image_attested"],
  },
  { from: "live_eligible", to: "live_running", action: "start_live", guards: ["live.gate_passed"] },
  {
    from: "backtested",
    to: "invalidated",
    action: "invalidate",
    guards: ["backtest.evidence_revoked"],
  },
  {
    from: "qualified",
    to: "superseded",
    action: "supersede",
    guards: ["version.newer_qualified"],
  },
  { from: "live_running", to: "retired", action: "retire", guards: ["deployment.stopped"] },
] as const satisfies readonly LifecycleTransition<
  AlgorithmLifecycleState,
  AlgorithmLifecycleAction,
  AlgorithmLifecycleGuard
>[]

export const ALGORITHM_LIFECYCLE = {
  states: ALGORITHM_LIFECYCLE_STATES,
  transitions: ALGORITHM_LIFECYCLE_TRANSITIONS,
} as const satisfies LifecycleDefinition<AlgorithmLifecycleState, AlgorithmLifecycleAction, AlgorithmLifecycleGuard>

export const algorithmLifecycle = createLifecycleEngine(ALGORITHM_LIFECYCLE)

/** Mutable projection; immutable version content lives in AlgorithmVersionRecord. */
export const AlgorithmVersionLifecycleRecordSchema = z
  .object({
    tenantId: TenantIdSchema,
    ref: AlgorithmVersionRefSchema,
    state: AlgorithmLifecycleStateSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict()
export type AlgorithmVersionLifecycleRecord = z.infer<typeof AlgorithmVersionLifecycleRecordSchema>
