import { describe, expect, test } from "bun:test"
import { harnessSealedHoldoutAnswers } from "../../../src/cli/cmd/run/harness-approval"

const request = {
  questions: [
    {
      header: "Open holdout",
      question: "Experiment plan: plan_1\nPlan hash: hash_1\nQualification policy: policy_1",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
  ],
}

const enabled = {
  FINNY_HARNESS_MODE: "1",
  FINNY_HARNESS_SCRIPTED_MODEL: "1",
  FINNY_HARNESS_APPROVE_SEALED_HOLDOUT: "1",
}

describe("headless sealed-holdout approval", () => {
  test("answers only inside the explicitly authorized hermetic fixture", () => {
    expect(harnessSealedHoldoutAnswers(request, enabled)).toEqual([["Approve"]])
    for (const key of Object.keys(enabled)) {
      expect(harnessSealedHoldoutAnswers(request, { ...enabled, [key]: undefined })).toBeUndefined()
    }
  })

  test("fails closed for tampered approval scope and structure", () => {
    const variants = [
      { questions: [{ ...request.questions[0], header: "Open paper" }] },
      { questions: [{ ...request.questions[0], question: "Experiment plan: plan_1" }] },
      { questions: [{ ...request.questions[0], options: [{ label: "Reject" }, { label: "Approve" }] }] },
      { questions: [{ ...request.questions[0] }, { ...request.questions[0] }] },
    ]
    for (const variant of variants) expect(harnessSealedHoldoutAnswers(variant, enabled)).toBeUndefined()
  })
})
