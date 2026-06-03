"""Canonical result schema for engine_v2.

schema_version semver rules:
  - Adding an optional field → minor bump (2.x.0).
  - Removing/renaming/retyping a field → major bump (3.0.0).
  - Anything fields-only and additive should not break TS results.ts parsers.

CHANGELOG:
  2.0.0  initial engine_v2 release.
  3.0.0  trade rows require multiplier; omega/profit_factor may be null.
  3.1.0  asset spec adds optional margin/commission metadata.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = "3.1.0"


@dataclass
class TradeRow:
    symbol: str
    side: str
    entry_ts: str
    exit_ts: str
    qty: float
    entry_price: float
    exit_price: float
    multiplier: float
    pnl: float
    pnl_pct: float
    r_multiple: Optional[float]
    fees: float
    funding: float
    borrow: float
    mae: float
    mfe: float
    hold_bars: int
    entry_tag: str
    exit_tag: str
    liquidation: bool = False


@dataclass
class DrawdownEntry:
    start_ts: str
    trough_ts: str
    end_ts: Optional[str]
    depth: float
    duration_bars: int
    recovery_bars: Optional[int]


@dataclass
class ReturnMetrics:
    total_return: float
    cagr: Optional[float]
    time_weighted_return: float
    money_weighted_return: Optional[float]
    best_day: float
    worst_day: float
    best_month: float
    worst_month: float
    pct_positive_months: float
    pct_positive_years: Optional[float]


@dataclass
class RiskMetrics:
    ann_vol: float
    downside_deviation: float
    semi_variance: float
    skew: float
    kurtosis: float
    var_95: float
    var_99: float
    cvar_95: float
    cvar_99: float
    ulcer_index: float
    pain_index: float
    tail_ratio: float


@dataclass
class RatioMetrics:
    sharpe: float
    sortino: float
    calmar: Optional[float]
    omega: Optional[float]
    mar: Optional[float]
    sterling: Optional[float]
    k_ratio: float


@dataclass
class DrawdownMetrics:
    max_drawdown: float
    max_dd_duration_bars: int
    max_dd_recovery_bars: Optional[int]
    avg_drawdown: float
    avg_dd_duration_bars: float
    current_drawdown: float
    top_drawdowns: List[DrawdownEntry]


@dataclass
class TradeMetrics:
    total_trades: int
    win_rate: float
    loss_rate: float
    breakeven_rate: float
    avg_win: float
    avg_loss: float
    payoff_ratio: float
    expectancy: float
    expectancy_r: Optional[float]
    profit_factor: Optional[float]
    max_consecutive_wins: int
    max_consecutive_losses: int
    longest_trade_bars: int
    shortest_trade_bars: int
    avg_hold_bars: float
    mae_avg: float
    mae_max: float
    mfe_avg: float
    mfe_max: float
    kelly_fraction: float
    kelly_confidence: str  # "low" | "medium" | "high"
    trade_tstat: Optional[float] = None
    trade_pvalue: Optional[float] = None


@dataclass
class ExposureMetrics:
    time_in_market_pct: float
    avg_gross_exposure: float
    avg_net_exposure: float
    max_gross_exposure: float
    total_turnover: float
    turnover_per_year: float
    total_fees: float
    fees_as_pct_return: Optional[float]
    total_funding: float
    total_borrow: float
    liquidation_count: int


@dataclass
class BenchmarkMetrics:
    benchmark_symbol: str
    alpha_annualized: float
    beta: float
    r_squared: float
    correlation: float
    tracking_error: float
    information_ratio: float
    treynor_ratio: Optional[float]
    up_capture: float
    down_capture: float


@dataclass
class StabilityMetrics:
    equity_curve_r2: float
    rolling_sharpe_window: int
    rolling_sharpe_mean: float
    rolling_sharpe_min: float
    monthly_returns: Dict[str, Dict[str, float]]  # year -> month -> return


@dataclass
class MonteCarloSummary:
    n_paths: int
    method: str  # "trade_shuffle" | "block_bootstrap"
    final_equity_p5: float
    final_equity_p50: float
    final_equity_p95: float
    max_dd_p50: float
    max_dd_p95: float
    max_dd_p99: float
    sharpe_p5: float
    sharpe_p50: float
    sharpe_p95: float


@dataclass
class WalkForwardFold:
    fold: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    is_sharpe: float
    oos_sharpe: float
    is_return: float
    oos_return: float


@dataclass
class WalkForwardSummary:
    n_folds: int
    is_sharpe_mean: float
    oos_sharpe_mean: float
    oos_decay: float
    flag_threshold: float
    flagged: bool
    deflated_sharpe: float
    probabilistic_sharpe: float
    folds: List[WalkForwardFold]


@dataclass
class RegimeBreakdown:
    regime: str  # "low_vol" | "mid_vol" | "high_vol"
    n_bars: int
    pct_of_window: float
    total_return: float
    sharpe: float
    max_drawdown: float
    n_trades: int
    win_rate: float


@dataclass
class OutlierDetail:
    timestamp: str
    previous_close: float
    current_close: float
    log_return: float
    z_score: float
    provider: str = "unknown"


@dataclass
class DataQualityReport:
    n_bars: int
    coverage_pct: float
    gap_count: int
    duplicate_ts_count: int
    ohlc_violations: int
    outlier_bars: int
    zero_volume_bars: int
    notes: List[str]
    outlier_details: List[OutlierDetail] = field(default_factory=list)
    repaired_outliers: int = 0
    repair_applied: bool = False


@dataclass
class PerSymbolAttribution:
    symbol: str
    realized_pnl: float
    unrealized_pnl: float
    n_trades: int
    win_rate: float
    contribution_pct: float


@dataclass
class AssetSpecReport:
    assetClass: str
    symbol: str
    currency: str
    calendar: str
    tickSize: float
    lotSize: float
    multiplier: float
    feeModel: str
    marginModel: str
    dataProvider: str
    productionEligible: bool
    initialMarginPct: Optional[float] = None
    maintenanceMarginPct: Optional[float] = None
    commissionPerContract: Optional[float] = None
    venue: Optional[str] = None
    expiry: Optional[str] = None
    rollPolicy: Optional[str] = None
    quoteCurrency: Optional[str] = None
    baseCurrency: Optional[str] = None
    blockingReason: Optional[str] = None


@dataclass
class Results:
    schema_version: str
    engine_version: str
    seed: int
    starting_equity: float
    ending_equity: float
    bars_processed: int
    interval: str
    start_ts: str
    end_ts: str
    symbols: List[str]

    # Legacy flat fields (back-compat with runner.ts:222-233).
    total_return: float
    max_drawdown: float
    ann_vol: float
    ann_sharpe: float
    total_trades: int
    win_rate: float
    profit_factor: Optional[float]

    # New structured blocks.
    returns: ReturnMetrics
    risk: RiskMetrics
    ratios: RatioMetrics
    drawdown: DrawdownMetrics
    trade: TradeMetrics
    exposure: ExposureMetrics
    stability: StabilityMetrics

    trades: List[TradeRow]
    per_symbol: List[PerSymbolAttribution]
    data_quality: DataQualityReport

    benchmark: Optional[BenchmarkMetrics] = None
    monte_carlo: Optional[MonteCarloSummary] = None
    walk_forward: Optional[WalkForwardSummary] = None
    regimes: Optional[List[RegimeBreakdown]] = None
    execution_config: Optional[Dict[str, Any]] = None
    diagnostics: Optional[Dict[str, Any]] = None
    run_metadata: Optional[Dict[str, Any]] = None
    asset_spec: Optional[AssetSpecReport] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
