import type { LiveRunner } from "@/live/runner"

export function liveStartRequest(params: LiveRunner.StartParams) {
  if (params.brokerKind === "robinhood") {
    if (params.executionMode !== "live") throw new Error("Robinhood only supports live execution")
    if (!params.challengeId) throw new Error("Robinhood live execution requires a current preflight challenge")
    if (params.realMoneyAcknowledgement !== true) {
      throw new Error("Robinhood live execution requires explicit real-money acknowledgement")
    }
  }
  return {
    algorithm: params.algorithm,
    runId: params.runId,
    symbol: params.symbol,
    interval: params.interval,
    accountProviderID: params.accountProviderID,
    brokerKind: params.brokerKind,
    executionMode: params.executionMode,
    ...(params.activationReceipt ? { activationReceipt: params.activationReceipt } : {}),
    ...(params.challengeId ? { challengeId: params.challengeId } : {}),
    ...(params.realMoneyAcknowledgement !== undefined
      ? { realMoneyAcknowledgement: params.realMoneyAcknowledgement }
      : {}),
  }
}
