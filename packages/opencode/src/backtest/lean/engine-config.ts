import { sha256Text } from "./contracts"
import type { LeanExecutionProfileV1 } from "./contracts"

/**
 * Deterministic LEAN launcher configuration for a Finny-certified backtest.
 * Every model is pinned explicitly: raw normalization, no fill-forward,
 * explicit fee/slippage models, bounded resources, file-system data, and the
 * offline backtesting environment. The resulting JSON is hashed into the run
 * identity so a config change is a new run.
 */
export function buildLeanLauncherConfig(input: {
  profile: LeanExecutionProfileV1
  assetFamily: "equity" | "crypto_spot"
  startDate: string
  endDate: string
  cash: number
  algorithmTypeName: string
  algorithmLanguage: "Python" | "CSharp"
  algorithmLocation: string
  dataFolder: string
  resultsFolder: string
  seed: number
  dataFeedWorkers: number
  /** Launcher assembly directory; the overlay image uses bin/Debug, the
   *  production image publishes Release directly under /Lean/Launcher. */
  launcherDir?: string
}): { config: Record<string, unknown>; json: string; configHash: string } {
  const launcherDir = input.launcherDir ?? "/Lean/Launcher/bin/Debug"
  const config: Record<string, unknown> = {
    environment: "backtesting",
    "algorithm-id": "Main",
    "algorithm-type-name": input.algorithmTypeName,
    "algorithm-language": input.algorithmLanguage,
    "algorithm-location": input.algorithmLocation,
    "data-folder": input.dataFolder,
    "results-destination-folder": input.resultsFolder,
    "close-automatically": true,
    "live-mode": false,
    "data-feed-handler": "QuantConnect.Lean.Engine.DataFeeds.FileSystemDataFeed",
    "result-handler": "QuantConnect.Lean.Engine.Results.BacktestingResultHandler",
    "setup-handler": "QuantConnect.Lean.Engine.Setup.BacktestingSetupHandler",
    "real-time-handler": "QuantConnect.Lean.Engine.RealTime.BacktestingRealTimeHandler",
    "transaction-handler": "QuantConnect.Lean.Engine.TransactionHandlers.BacktestingTransactionHandler",
    "history-provider": ["QuantConnect.Lean.Engine.HistoricalData.SubscriptionDataReaderHistoryProvider"],
    "data-provider": "QuantConnect.Lean.Engine.DataFeeds.DefaultDataProvider",
    "data-channel-provider": "DataChannelProvider",
    "object-store": "QuantConnect.Lean.Engine.Storage.LocalObjectStore",
    "map-file-provider": "QuantConnect.Data.Auxiliary.LocalDiskMapFileProvider",
    "factor-file-provider": "QuantConnect.Data.Auxiliary.LocalDiskFactorFileProvider",
    "data-feed-workers": input.dataFeedWorkers,
    "initialization-timeout": 300,
    "algorithm-manager-time-loop-maximum": 20,
    "maximum-data-points-per-chart-series": 1000000,
    "maximum-chart-series": 30,
    "storage-limit-mb": 512,
    "storage-file-count": 10000,
    "job-user-id": "0",
    "api-access-token": "",
    "job-organization-id": "",
    "parameters": {
      "finny-seed": input.seed,
      "finny-phase": "backtest",
      "finny-start-date": input.startDate,
      "finny-end-date": input.endDate,
      "finny-cash": input.cash,
      "finny-fee-maker-bps": input.profile.fees.makerFeeBps,
      "finny-fee-taker-bps": input.profile.fees.takerFeeBps,
      "finny-slippage-bps": input.profile.slippageBps,
      "finny-max-leverage": input.profile.buyingPower.maxLeverage,
      "finny-maintenance-margin-pct": input.profile.buyingPower.maintenanceMarginPct,
      "finny-shorting-enabled": input.profile.shortingEnabled,
      "finny-volume-participation-cap-pct": input.profile.volumeParticipationCapPct,
    },
  }
  if (input.algorithmLanguage === "Python") {
    config["python-additional-paths"] = [launcherDir, "/Lean/Algorithm"]
  }
  const json = `${JSON.stringify(config, null, 2)}\n`
  return { config, json, configHash: sha256Text(json) }
}
