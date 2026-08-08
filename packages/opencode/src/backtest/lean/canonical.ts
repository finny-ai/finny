import { EngineV2 } from "../results"
import type { CrucibleResultV1 } from "./types"

/**
 * Adapter from a legacy engine_v2 blob into the canonical result shape.
 * Ratio metrics are carried at their stored precision; the canonical gate
 * layer is responsible for any precision policy.
 */
export function crucibleResultFromEngineV2(v2: EngineV2.Results): CrucibleResultV1 {
  return {
    schema: "finny.crucible_result",
    version: 1,
    runtimeProfileId: "finny_python",
    startingEquity: v2.starting_equity,
    endingEquity: v2.ending_equity,
    totalReturn: v2.total_return,
    maxDrawdown: v2.max_drawdown,
    annualizedVolatility: v2.ann_vol,
    sharpeRatio: v2.ann_sharpe,
    totalTrades: v2.total_trades,
    winRate: v2.win_rate,
    profitFactor: v2.profit_factor,
    fees: v2.cost_attribution?.fees ?? 0,
    slippage: 0,
    exposure: v2.exposure?.max_gross_exposure ?? 0,
    navCurve: (v2.nav_summary ? [{ timestamp: v2.end_ts, equity: v2.nav_summary.mark_to_market_nav }] : []),
    orders: (v2.trades ?? []).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      entry_ts: trade.entry_ts,
      exit_ts: trade.exit_ts,
      qty: trade.qty,
    })),
    fills: (v2.trades ?? []).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      entry_ts: trade.entry_ts,
      entry_price: trade.entry_price,
      exit_ts: trade.exit_ts,
      exit_price: trade.exit_price,
      qty: trade.qty,
      fees: trade.fees,
      pnl: trade.pnl,
    })),
    rejections: [],
    diagnostics: {
      barsProcessed: v2.bars_processed,
      rejectedOrders: Number((v2.diagnostics as any)?.rejected_orders ?? 0),
      pendingOrdersAtEnd: Number((v2.diagnostics as any)?.pending_orders_at_end ?? 0),
      strategyErrors: Number((v2.diagnostics as any)?.strategy_errors ?? 0),
    },
    engineVersion: v2.engine_version,
    runKind: "crucible_2_0",
  }
}
