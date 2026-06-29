/**
 * TS mirror of engine_v2.report.schema. Hand-maintained — when schema.py
 * adds a field, mirror it here. When it bumps to a major version, update
 * the SCHEMA_VERSION_MAJOR constant and refuse to parse incompatible blobs.
 *
 * All blocks except the legacy flat fields are optional in the TS view,
 * since a v1-fallback run won't populate them.
 */

export namespace EngineV2 {
  export const SCHEMA_VERSION_MAJOR = 3

  export interface TradeRow {
    symbol: string
    side: "long" | "short"
    entry_ts: string
    exit_ts: string
    qty: number
    entry_price: number
    exit_price: number
    multiplier?: number
    pnl: number
    pnl_pct: number
    r_multiple: number | null
    fees: number
    funding: number
    borrow: number
    mae: number
    mfe: number
    hold_bars: number
    entry_tag: string
    exit_tag: string
    liquidation: boolean
  }

  export interface OpenTradeRow {
    symbol: string
    side: "long" | "short"
    qty: number
    entry_ts: string
    entry_price: number
    mark_price: number
    multiplier: number
    unrealized_pnl: number
    fees_accrued: number
    funding_accrued: number
    borrow_accrued: number
    hold_bars: number
    entry_tag: string
  }

  export interface DrawdownEntry {
    start_ts: string
    trough_ts: string
    end_ts: string | null
    depth: number
    duration_bars: number
    recovery_bars: number | null
  }

  export interface ReturnMetrics {
    total_return: number
    cagr: number | null
    time_weighted_return: number
    money_weighted_return: number | null
    best_day: number
    worst_day: number
    best_month: number
    worst_month: number
    pct_positive_months: number
    pct_positive_years: number | null
  }

  export interface RiskMetrics {
    ann_vol: number
    downside_deviation: number
    semi_variance: number
    skew: number
    kurtosis: number
    var_95: number
    var_99: number
    cvar_95: number
    cvar_99: number
    ulcer_index: number
    pain_index: number
    tail_ratio: number
  }

  export interface RatioMetrics {
    sharpe: number
    sortino: number
    calmar: number | null
    omega: number | null
    mar: number | null
    sterling: number | null
    k_ratio: number
  }

  export interface DrawdownMetrics {
    max_drawdown: number
    max_dd_duration_bars: number
    max_dd_recovery_bars: number | null
    avg_drawdown: number
    avg_dd_duration_bars: number
    current_drawdown: number
    top_drawdowns: DrawdownEntry[]
  }

  export interface TradeMetrics {
    total_trades: number
    win_rate: number
    loss_rate: number
    breakeven_rate: number
    avg_win: number
    avg_loss: number
    payoff_ratio: number
    expectancy: number
    expectancy_r: number | null
    profit_factor: number | null
    max_consecutive_wins: number
    max_consecutive_losses: number
    longest_trade_bars: number
    shortest_trade_bars: number
    avg_hold_bars: number
    mae_avg: number
    mae_max: number
    mfe_avg: number
    mfe_max: number
    kelly_fraction: number
    kelly_confidence: "low" | "medium" | "high"
    trade_tstat: number | null
    trade_pvalue: number | null
  }

  export interface ExposureMetrics {
    time_in_market_pct: number
    avg_gross_exposure: number
    avg_net_exposure: number
    max_gross_exposure: number
    total_turnover: number
    turnover_per_year: number
    total_fees: number
    fees_as_pct_return: number | null
    total_funding: number
    total_borrow: number
    liquidation_count: number
  }

  export interface BenchmarkMetrics {
    benchmark_symbol: string
    benchmark_total_return: number
    strategy_excess_return: number
    alpha_annualized: number
    beta: number
    r_squared: number
    correlation: number
    tracking_error: number
    information_ratio: number
    treynor_ratio: number | null
    up_capture: number
    down_capture: number
  }

  export interface StabilityMetrics {
    equity_curve_r2: number
    rolling_sharpe_window: number
    rolling_sharpe_mean: number
    rolling_sharpe_min: number
    monthly_returns: Record<string, Record<string, number>>
  }

  export interface MonteCarloSummary {
    n_paths: number
    method: "trade_shuffle" | "block_bootstrap"
    final_equity_p5: number
    final_equity_p50: number
    final_equity_p95: number
    max_dd_p50: number
    max_dd_p95: number
    max_dd_p99: number
    sharpe_p5: number
    sharpe_p50: number
    sharpe_p95: number
  }

  export interface WalkForwardFold {
    fold: number
    train_start: string
    train_end: string
    test_start: string
    test_end: string
    is_sharpe: number | null
    oos_sharpe: number | null
    is_return: number
    oos_return: number
    oos_trades?: number
    oos_bars?: number
    oos_coverage?: number
    oos_max_drawdown?: number
    ruined?: boolean
    selected_params?: Record<string, unknown> | null
  }

  export interface WalkForwardSummary {
    n_folds: number
    is_sharpe_mean: number
    oos_sharpe_mean: number
    oos_decay: number
    is_to_oos_sharpe_change?: number
    flag_threshold: number
    flagged: boolean
    deflated_sharpe: number | null
    probabilistic_sharpe: number | null
    stitched_oos_return?: number
    stitched_oos_sharpe?: number
    stitched_oos_trades?: number
    stitched_oos_bars?: number
    stitched_oos_coverage?: number
    ruined_folds?: number
    multiple_testing_trials?: number
    folds: WalkForwardFold[]
  }

  export interface RegimeBreakdown {
    regime: "low_vol" | "mid_vol" | "high_vol"
    n_bars: number
    pct_of_window: number
    total_return: number
    sharpe: number
    max_drawdown: number
    n_trades: number
    win_rate: number
  }

  export interface DataQualityReport {
    n_bars: number
    coverage_pct: number
    gap_count: number
    duplicate_ts_count: number
    ohlc_violations: number
    outlier_bars: number
    zero_volume_bars: number
    notes: string[]
    outlier_details?: Array<{
      timestamp: string
      previous_close: number
      current_close: number
      log_return: number
      z_score: number
      provider?: string
    }>
    repaired_outliers?: number
    repair_applied?: boolean
  }

  export interface ExecutionConfig {
    profile_id?: string
    profile_version?: string
    profile_defaults?: Record<string, unknown>
    effective_values?: Record<string, unknown>
    overrides?: Record<string, unknown>
    scenarios?: Record<string, Record<string, unknown>>
    fill_model: string
    participation_pct: number
    maker_fee_bps: number
    taker_fee_bps: number
    commission_per_contract?: number
    slippage_bps: number
    k_atr: number
    k_vol: number
    spread_enabled: boolean
    spread_k: number
    spread_lookback: number
    max_leverage: number
    initial_margin_pct?: number
    maintenance_margin_pct: number
    funding_enabled?: boolean
    funding_rate_bps?: number
    funding_interval_hours?: number
    liquidation_enabled?: boolean
    asset_class?: string
    multiplier?: number
    tick_size?: number
    lot_size?: number
  }

  export interface AssetSpecReport {
    assetClass: string
    symbol: string
    currency: string
    calendar: string
    tickSize: number
    lotSize: number
    multiplier: number
    feeModel: string
    marginModel: string
    dataProvider: string
    productionEligible: boolean
    initialMarginPct?: number | null
    maintenanceMarginPct?: number | null
    commissionPerContract?: number | null
    venue?: string | null
    expiry?: string | null
    rollPolicy?: string | null
    quoteCurrency?: string | null
    baseCurrency?: string | null
    blockingReason?: string | null
  }

  export interface PerSymbolAttribution {
    symbol: string
    realized_pnl: number
    unrealized_pnl: number
    n_trades: number
    win_rate: number
    contribution_pct: number
  }

  export interface NavSummary {
    mark_to_market_nav: number
    liquidation_nav: number
    explanation: string
  }

  export interface CostAttributionSummary {
    total_costs: number
    fees: number
    funding: number
    borrow: number
    cost_as_pct_starting_equity: number
    explanation: string
  }

  export interface ProfileIdentity {
    product_label: string
    profile_id: string
    strategy_hash?: string | null
    config_hash?: string | null
    data_hash?: string | null
    explanation: string
  }

  export interface SensitivityOutcome {
    name: string
    status: string
    value: number | null
    explanation: string
  }

  export interface ResultExplanations {
    product: string
    mark_to_market_nav: string
    liquidation_nav: string
    cost_attribution: string
    profile_identity: string
    sensitivity_outcomes: string
  }

  export interface Results {
    schema_version: string
    engine_version: string
    seed: number
    starting_equity: number
    ending_equity: number
    bars_processed: number
    interval: string
    start_ts: string
    end_ts: string
    symbols: string[]

    // Legacy flat fields for back-compat with the existing UI/contract.
    total_return: number
    max_drawdown: number
    ann_vol: number
    ann_sharpe: number
    total_trades: number
    win_rate: number
    profit_factor: number | null

    returns: ReturnMetrics
    risk: RiskMetrics
    ratios: RatioMetrics
    drawdown: DrawdownMetrics
    trade: TradeMetrics
    exposure: ExposureMetrics
    stability: StabilityMetrics

    trades: TradeRow[]
    open_trades?: OpenTradeRow[]
    per_symbol: PerSymbolAttribution[]
    data_quality: DataQualityReport

    benchmark?: BenchmarkMetrics | null
    monte_carlo?: MonteCarloSummary | null
    walk_forward?: WalkForwardSummary | null
    regimes?: RegimeBreakdown[] | null
    execution_config?: ExecutionConfig | null
    diagnostics?: Record<string, unknown> | null
    run_metadata?: Record<string, unknown> | null
    asset_spec?: AssetSpecReport | null
    product_label?: string
    run_kind?: "crucible_2_0" | "legacy"
    nav_summary?: NavSummary | null
    cost_attribution?: CostAttributionSummary | null
    profile_identity?: ProfileIdentity | null
    sensitivity_outcomes?: SensitivityOutcome[]
    explanations?: ResultExplanations | null
  }
}
