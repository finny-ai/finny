import type { LiveRunner } from "@/live/runner"

export function liveStartRequest(params: LiveRunner.StartParams) {
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
