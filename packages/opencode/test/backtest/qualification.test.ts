import { describe, expect, test } from "bun:test"
import { qualifyCandidateV1 } from "../../src/backtest/qualification"
import { qualificationInputForResearch } from "../../src/backtest/qualification-policy"

const failedResults = {
  totalReturn: -0.1,
  maxDrawdown: 0.2,
  annualizedVolatility: 0.2,
  sharpeRatio: -0.5,
  endingEquity: 9000,
  totalTrades: 10,
  winRate: 0.3,
  profitFactor: 0.7,
} as any

describe("qualifyCandidateV1", () => {
  test("returns one stable actionable blocker", () => {
    const result = qualifyCandidateV1({
      candidateId: "candidate-1",
      results: failedResults,
      qualification: qualificationInputForResearch({ phase: "validation" }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocker.code).toBe("invalid_policy")
    expect(result.blocker.field).toBe("qualificationPolicy")
    expect(result.blocker.nextAllowedTransition).toBe("supply the exact immutable QualificationPolicyV1")
  })
})
