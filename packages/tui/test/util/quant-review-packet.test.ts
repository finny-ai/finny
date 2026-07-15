import { describe, expect, test } from "bun:test"
import { keepCompletedToolVisible, quantReviewPacketHref } from "../../src/util/quant-review-packet"

describe("quant review packet TUI contract", () => {
  test("keeps the completed finalizer visible when generic completed tools collapse", () => {
    expect(keepCompletedToolVisible("finny_review_packet")).toBe(true)
    expect(keepCompletedToolVisible("finny_backtest")).toBe(false)
  })

  test("passes the exact local review path to Link", () => {
    const reviewPath = "/tmp/finny/algorithms/algo/reviews/exp/review.html"
    expect(quantReviewPacketHref({ reviewPath })).toBe(reviewPath)
    expect(quantReviewPacketHref({ reviewPath: "" })).toBeUndefined()
    expect(quantReviewPacketHref({})).toBeUndefined()
  })
})
