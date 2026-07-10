import { describe, expect, test } from "bun:test"
import { makeApprovalChallenge } from "@/algorithm/build-workflow/state"
import {
  approvalDecisionFromAnswers,
  approvalPromptForChallenge,
} from "@/tool/workflow-request-approval"

describe("finny_workflow_request_approval", () => {
  const challenge = makeApprovalChallenge({
    id: "challenge_exact",
    kind: "failure_budget_override",
    scope: { conceptId: "concept_hash", priorUniqueTrials: 5 },
    reason: "Continue this exact concept after the selection budget.",
    now: 1,
  })

  test("renders only the controller-created scope and disables custom answers", () => {
    const prompt = approvalPromptForChallenge(challenge)
    expect(prompt.custom).toBe(false)
    expect(prompt.multiple).toBe(false)
    expect(prompt.question).toContain(challenge.scopeHash)
    expect(prompt.question).toContain(JSON.stringify(challenge.scope))
    expect(prompt.options.map((item) => item.label)).toEqual(["Approve", "Reject"])
  })

  test("only the exact structured approve selection grants approval", () => {
    expect(approvalDecisionFromAnswers([["Approve"]])).toBe("approve")
    expect(approvalDecisionFromAnswers([["Approve", "Reject"]])).toBe("reject")
    expect(approvalDecisionFromAnswers([["yes"]])).toBe("reject")
    expect(approvalDecisionFromAnswers([])).toBe("reject")
  })
})
