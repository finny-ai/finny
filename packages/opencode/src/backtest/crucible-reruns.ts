export type CrucibleRepresentativeRerun = {
  name: string
  expectedAlgorithmName: string
  duration: string
  interval: "1min" | "5min" | "15min" | "30min" | "1h" | "4h" | "1d"
  capital: string
  assetClass: "equities" | "crypto" | "futures"
  gate: "strict_v2"
}

export const CRUCIBLE_2_0_PRODUCT_LABEL = "Crucible 2.0"

export const CRUCIBLE_REPRESENTATIVE_RERUNS: readonly CrucibleRepresentativeRerun[] = [
  {
    name: "Buy-and-hold BTC",
    expectedAlgorithmName: "buy-and-hold-btc",
    duration: "5y",
    interval: "1d",
    capital: "10000",
    assetClass: "crypto",
    gate: "strict_v2",
  },
  {
    name: "BTC 200-day filter",
    expectedAlgorithmName: "btc-200-day-filter",
    duration: "5y",
    interval: "1d",
    capital: "10000",
    assetClass: "crypto",
    gate: "strict_v2",
  },
  {
    name: "BTC Donchian/ATR",
    expectedAlgorithmName: "btc-donchian-atr",
    duration: "3y",
    interval: "1d",
    capital: "10000",
    assetClass: "crypto",
    gate: "strict_v2",
  },
  {
    name: "BTC 4h trend/ATR",
    expectedAlgorithmName: "btc-4h-trend-atr",
    duration: "2y",
    interval: "4h",
    capital: "10000",
    assetClass: "crypto",
    gate: "strict_v2",
  },
  {
    name: "SPY intraday crossover",
    expectedAlgorithmName: "spy-intraday-crossover",
    duration: "1y",
    interval: "5min",
    capital: "25000",
    assetClass: "equities",
    gate: "strict_v2",
  },
  {
    name: "ES futures smoke strategy",
    expectedAlgorithmName: "es-futures-smoke-strategy",
    duration: "6m",
    interval: "1d",
    capital: "50000",
    assetClass: "futures",
    gate: "strict_v2",
  },
]

export function representativeRerunForAlgorithm(name: string): CrucibleRepresentativeRerun | undefined {
  const normalized = name.toLowerCase()
  return CRUCIBLE_REPRESENTATIVE_RERUNS.find(
    (run) => run.expectedAlgorithmName === normalized || run.name.toLowerCase() === normalized,
  )
}
