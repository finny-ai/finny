import { expect, test } from "bun:test"
import { liveStartRequest } from "./live-start-request"

const algorithm = {
  algorithmId: "algo-1",
  userId: "user-1",
  name: "momentum",
  code: "class Strategy: pass",
  language: "python",
  version: 4,
  status: "backtested",
  time_created: 1,
  time_updated: 2,
}

test("Robinhood live start explicitly carries execution activation intent", () => {
  expect(
    liveStartRequest({
      algorithm,
      runId: "strict-run-1",
      symbol: "AAPL",
      interval: "1min",
      brokerKind: "robinhood",
      accountProviderID: "robinhood-agentic-1",
      executionMode: "live",
      challengeId: "challenge-1",
      realMoneyAcknowledgement: true,
    }),
  ).toEqual({
    algorithm,
    runId: "strict-run-1",
    symbol: "AAPL",
    interval: "1min",
    brokerKind: "robinhood",
    accountProviderID: "robinhood-agentic-1",
    executionMode: "live",
    challengeId: "challenge-1",
    realMoneyAcknowledgement: true,
  })
})

test("non-Robinhood starts still send an explicit execution mode without activation fields", () => {
  expect(
    liveStartRequest({
      algorithm,
      runId: "strict-run-2",
      symbol: "MSFT",
      interval: "5min",
      brokerKind: "alpaca",
      accountProviderID: "alpaca-paper-1",
      executionMode: "paper",
    }),
  ).toEqual({
    algorithm,
    runId: "strict-run-2",
    symbol: "MSFT",
    interval: "5min",
    brokerKind: "alpaca",
    accountProviderID: "alpaca-paper-1",
    executionMode: "paper",
  })
})

test("Robinhood starts fail closed without exact live activation intent", () => {
  const base = {
    algorithm,
    runId: "strict-run-1",
    symbol: "AAPL",
    interval: "1min",
    brokerKind: "robinhood" as const,
    accountProviderID: "robinhood-agentic-1",
  }
  expect(() => liveStartRequest({ ...base, executionMode: "paper" })).toThrow("only supports live")
  expect(() => liveStartRequest({ ...base, executionMode: "live", realMoneyAcknowledgement: true })).toThrow(
    "preflight challenge",
  )
  expect(() => liveStartRequest({ ...base, executionMode: "live", challengeId: "challenge-1" })).toThrow(
    "real-money acknowledgement",
  )
})
