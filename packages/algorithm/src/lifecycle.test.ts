import { describe, expect, test } from "bun:test"
import {
  ALGORITHM_LIFECYCLE_ACTIONS,
  ALGORITHM_LIFECYCLE_STATES,
  ALGORITHM_LIFECYCLE_TRANSITIONS,
  AlgorithmLifecycleAction,
  AlgorithmLifecycleGuard,
  algorithmLifecycle,
  createLifecycleEngine,
} from "./lifecycle"

function passingGuards(guards: readonly AlgorithmLifecycleGuard[]): Partial<Record<AlgorithmLifecycleGuard, boolean>> {
  return Object.fromEntries(guards.map((guard) => [guard, true]))
}

describe("algorithm lifecycle", () => {
  test("accepts every declared canonical transition", () => {
    for (const declaration of ALGORITHM_LIFECYCLE_TRANSITIONS) {
      const guards = passingGuards(declaration.guards)
      expect(algorithmLifecycle.legalNextActions(declaration.from, guards)).toContainEqual({
        action: declaration.action,
        from: declaration.from,
        to: declaration.to,
        guards: declaration.guards,
      })
      expect(algorithmLifecycle.transition(declaration.from, declaration.action, guards)).toEqual({
        ok: true,
        action: declaration.action,
        from: declaration.from,
        to: declaration.to,
      })
    }
  })

  test("rejects every action that is not an edge from the current state", () => {
    for (const state of ALGORITHM_LIFECYCLE_STATES) {
      const legal = new Set<AlgorithmLifecycleAction>(
        ALGORITHM_LIFECYCLE_TRANSITIONS.filter((transition) => transition.from === state).map(
          (transition) => transition.action,
        ),
      )
      for (const action of ALGORITHM_LIFECYCLE_ACTIONS) {
        if (legal.has(action)) continue
        expect(
          algorithmLifecycle.transition(
            state,
            action,
            Object.fromEntries(
              ALGORITHM_LIFECYCLE_TRANSITIONS.flatMap((item) => item.guards.map((guard) => [guard, true])),
            ) as Partial<Record<AlgorithmLifecycleGuard, boolean>>,
          ),
        ).toEqual({ ok: false, reason: "illegal-transition", state, action })
      }
    }
  })

  test("fails closed when a guard is missing or rejects the transition", () => {
    expect(algorithmLifecycle.legalNextActions("draft", {})).toEqual([])
    expect(algorithmLifecycle.transition("draft", "validate", {})).toEqual({
      ok: false,
      reason: "missing-guards",
      state: "draft",
      action: "validate",
      guards: ["validation.passed"],
    })
    expect(algorithmLifecycle.transition("draft", "validate", { "validation.passed": false })).toEqual({
      ok: false,
      reason: "rejected-guards",
      state: "draft",
      action: "validate",
      guards: ["validation.passed"],
    })
  })

  test("engine behavior comes entirely from a supplied transition table", () => {
    const engine = createLifecycleEngine({
      states: ["one", "two", "three"] as const,
      transitions: [
        { from: "one", to: "two", action: "advance", guards: ["ready"] },
        { from: "two", to: "three", action: "finish", guards: [] },
      ] as const,
    })
    expect(engine.transition("one", "advance", { ready: true })).toMatchObject({ ok: true, to: "two" })
    expect(engine.legalNextActions("two", {})).toMatchObject([{ action: "finish", to: "three" }])
  })

  test("snapshots declarations and does not expose internal guard arrays", () => {
    type State = "one" | "two" | "three"
    type Action = "advance" | "skip"
    type Guard = "ready" | "blocked"

    const states: State[] = ["one", "two", "three"]
    const declaration: { from: State; to: State; action: Action; guards: Guard[] } = {
      from: "one",
      to: "two",
      action: "advance",
      guards: ["ready"],
    }
    const transitions = [declaration]
    const engine = createLifecycleEngine<State, Action, Guard>({ states, transitions })

    declaration.to = "three"
    declaration.action = "skip"
    declaration.guards[0] = "blocked"
    states.splice(0, states.length, "three")
    transitions.splice(0, transitions.length)

    const actions = engine.legalNextActions("one", { ready: true })
    const [action] = actions
    if (!action) throw new Error("snapshotted transition was not available")
    expect(actions).toMatchObject([{ action: "advance", from: "one", to: "two", guards: ["ready"] }])
    expect(Object.isFrozen(actions)).toBe(true)
    expect(Object.isFrozen(action)).toBe(true)
    expect(Object.isFrozen(action.guards)).toBe(true)
    expect(Reflect.set(action.guards, 0, "blocked")).toBe(false)
    expect(engine.transition("one", "advance", { ready: true })).toEqual({
      ok: true,
      action: "advance",
      from: "one",
      to: "two",
    })
  })
})
