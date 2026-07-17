import { describe, expect, test } from "bun:test"
import {
  DEFAULT_QUALIFICATION_POLICY_V1,
  makeHoldoutOpenEventV1,
  qualificationInputErrors,
  type QualificationContextV1,
} from "../../src/backtest/qualification-policy"

const context: QualificationContextV1 = {
  schema: "finny.qualification_context",
  version: 1,
  planId: "plan-qualified",
  planHash: "a".repeat(64),
  phase: "confirmatory",
  holdoutOpenEvents: [
    makeHoldoutOpenEventV1({
      planId: "plan-qualified",
      planHash: "a".repeat(64),
      approvalHash: "c".repeat(64),
      openedAt: "2026-07-14T00:00:00.000Z",
    }),
  ],
  durableSelectionBudget: 20,
  durableTrialCount: 20,
  datasetEvidenceId: "dataset-qualified",
  datasetHash: "b".repeat(64),
  datasetQualification: "strict_qualified",
  dataQualityMode: "strict",
}

describe("QualificationPolicyV1", () => {
  test("accepts the exact policy and promotable context", () => {
    expect(qualificationInputErrors({ policy: DEFAULT_QUALIFICATION_POLICY_V1, context })).toEqual([])
  })

  test("fails closed on policy tampering", () => {
    const policy = { ...DEFAULT_QUALIFICATION_POLICY_V1, minTrades: 1 }
    expect(qualificationInputErrors({ policy, context }).join(" ")).toContain("policy hash mismatch")
  })

  test("fails closed on phase, holdout, budget, evidence, and mode mismatch", () => {
    const errors = qualificationInputErrors({
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
      context: {
        ...context,
        phase: "validation",
        holdoutOpenEvents: [],
        durableTrialCount: 21,
        datasetQualification: "research_only",
        dataQualityMode: "repair_outliers",
      },
    }).join("\n")
    expect(errors).toContain("not confirmatory")
    expect(errors).toContain("sealed holdout")
    expect(errors).toContain("budget was exceeded")
    expect(errors).toContain("is not promotable")
    expect(errors).toContain("research-only")
  })

  test("requires exactly one matching immutable holdout-open event", () => {
    const duplicate = { ...context, holdoutOpenEvents: [context.holdoutOpenEvents[0], context.holdoutOpenEvents[0]] }
    expect(
      qualificationInputErrors({ policy: DEFAULT_QUALIFICATION_POLICY_V1, context: duplicate }).join(" "),
    ).toContain("exactly one")
    const tampered = {
      ...context,
      holdoutOpenEvents: [{ ...context.holdoutOpenEvents[0], approvalHash: "d".repeat(64) }],
    }
    expect(
      qualificationInputErrors({ policy: DEFAULT_QUALIFICATION_POLICY_V1, context: tampered }).join(" "),
    ).toContain("event hash mismatch")
  })
})
