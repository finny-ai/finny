import z from "zod"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Process } from "@/util/process"
import { resolveSessionPythonEnv } from "@/python/session-env"

const parameters = z.object({
  holdings: z
    .array(
      z.object({
        ticker: z
          .string()
          .trim()
          .min(1, "Ticker cannot be empty.")
          .describe(
            "yfinance-compatible ticker. Equities use the bare symbol (VOO, AAPL, VFV.TO). Crypto uses dash form (BTC-USD, ETH-USD). Foreign listings use suffixes (e.g. VFV.TO for TSX).",
          ),
        weight: z.number().min(0).max(1).describe("Portfolio weight as a decimal (0–1). All weights must sum to ~1.0."),
        assetClass: z.enum(["stock", "etf", "crypto", "bond", "cash"]).optional(),
      }),
    )
    .min(1)
    // 50 covers any reasonable retail portfolio; anything beyond risks
    // multi-minute yfinance fan-out (price download + per-ticker currency
    // detection) and would blow past the 120s tool timeout.
    .max(50, "At most 50 tickers — keeps backtests fast and avoids excessive market-data downloads.")
    // Dedupe by case-folded ticker. The Python side builds weights via dict
    // comprehension (last-write-wins), so duplicates would silently change
    // the allocation AND make the TS-side sum-to-1 check disagree with what
    // actually runs. Force callers to merge explicitly.
    .refine(
      (items) => {
        const seen = new Set<string>()
        for (const h of items) {
          const k = h.ticker.trim().toUpperCase()
          if (seen.has(k)) return false
          seen.add(k)
        }
        return true
      },
      {
        message:
          "Duplicate tickers in holdings — combine each ticker into a single entry and sum the weights.",
      },
    )
    .describe("Holdings in the portfolio with their target weights. Max 50 tickers, no duplicates."),
  capital: z.number().positive().default(10000).describe("Starting capital in the user's currency (numeric)."),
  duration: z
    .string()
    .regex(/^\d+[dwmy]$/i, "Duration must match <number><unit> where unit is d/w/m/y (e.g. '5d', '2w', '1m', '5y')")
    .default("5y")
    .describe("Backtest window as <number><unit>. Default '5y'."),
  rebalance: z
    .enum(["none", "monthly", "quarterly", "yearly"])
    .default("monthly")
    .describe("Rebalancing cadence. 'none' = pure buy-and-hold."),
  currency: z
    .enum(["USD", "CAD", "EUR"])
    .default("USD")
    .describe("ISO currency for `capital` and output formatting. Default 'USD'."),
})

const PORTFOLIO_BACKTEST_PY = String.raw`
# yfinance + pandas are guaranteed to be installed by the managed venv before
# this script runs (see ensurePythonEnv call in portfolio-backtest.ts). No
# subprocess pip install fallback — that path was broken on PEP 668 / no-pip
# Linux and could pollute stdout.
import sys, json, argparse, math
import yfinance as yf
import pandas as pd

p = argparse.ArgumentParser()
p.add_argument("--config", required=True)
args = p.parse_args()

with open(args.config) as f:
    cfg = json.load(f)

holdings = cfg["holdings"]
capital = float(cfg["capital"])
start = cfg["start"]
end = cfg["end"]
rebalance = cfg["rebalance"]
target_ccy = (cfg.get("currency") or "USD").upper()

tickers = [h["ticker"] for h in holdings]
weights = {h["ticker"]: float(h["weight"]) for h in holdings}

raw = yf.download(tickers, start=start, end=end, progress=False, auto_adjust=True)
if raw is None or raw.empty:
    print(json.dumps({"ok": False, "error": "yfinance returned no data for the requested tickers/window."}))
    sys.exit(0)

# yfinance returns a multiindex when given >1 ticker, single-level for 1 ticker.
if isinstance(raw.columns, pd.MultiIndex):
    px = raw["Close"].copy() if "Close" in raw.columns.levels[0] else raw["Adj Close"].copy()
else:
    col = "Close" if "Close" in raw.columns else "Adj Close"
    px = raw[[col]].copy()
    px.columns = tickers

# Forward-fill across calendar gaps (crypto trades weekends, equities don't).
px = px.sort_index().ffill().dropna(how="all")

# Drop tickers with no data; renormalize weights.
present = [t for t in tickers if t in px.columns and px[t].notna().any()]
missing = [t for t in tickers if t not in present]
if not present:
    print(json.dumps({"ok": False, "error": "No usable price data for any ticker."}))
    sys.exit(0)

px = px[present].dropna()
if len(px) < 2:
    print(json.dumps({"ok": False, "error": "Not enough overlapping price history."}))
    sys.exit(0)

# --- FX conversion --------------------------------------------------------
# yfinance returns prices in each security's listing currency (VFV.TO is CAD,
# VOO is USD, BTC-USD is USD). The portfolio math here assumes a single
# currency for capital + prices, so any non-target series must be converted
# before computing shares/equity. Without this, mixed-currency portfolios
# (the canonical TFSA case mixing US + Canadian listings) would produce
# unit-mismatched equity curves.
def detect_currency(t):
    tk = yf.Ticker(t)
    try:
        fi = tk.fast_info
        ccy = getattr(fi, "currency", None)
        if not ccy and hasattr(fi, "get"):
            ccy = fi.get("currency")
        if ccy:
            return str(ccy).upper()
    except Exception:
        pass
    try:
        info = tk.info or {}
        ccy = info.get("currency")
        if ccy:
            return str(ccy).upper()
    except Exception:
        pass
    return "USD"

ticker_ccy = {t: detect_currency(t) for t in present}
fx_needed = sorted({c for c in ticker_ccy.values() if c != target_ccy})
fx_series = {}
fx_failures = []
for src in fx_needed:
    pair = f"{src}{target_ccy}=X"
    try:
        fx = yf.download(pair, start=start, end=end, progress=False, auto_adjust=True)
        if fx is None or fx.empty:
            fx_failures.append(src)
            continue
        col = "Close" if "Close" in fx.columns else "Adj Close"
        s = fx[col]
        if isinstance(s, pd.DataFrame):
            s = s.iloc[:, 0]
        fx_series[src] = s.reindex(px.index).ffill()
    except Exception:
        fx_failures.append(src)

if fx_failures:
    print(json.dumps({
        "ok": False,
        "error": f"Could not fetch FX rates to convert into {target_ccy}: {fx_failures}. Use a target currency that yfinance has rates for, or restrict the portfolio to that currency.",
    }))
    sys.exit(0)

for t in present:
    src = ticker_ccy[t]
    if src != target_ccy:
        px[t] = px[t] * fx_series[src]

# After FX, drop any rows where conversion left NaNs. This begins the
# portfolio at the first jointly observable date across assets and FX rates;
# no future FX rates are backfilled into earlier portfolio dates.
px = px.dropna()
if len(px) < 2:
    print(json.dumps({"ok": False, "error": "Not enough overlapping data after FX conversion."}))
    sys.exit(0)

w = pd.Series({t: weights[t] for t in present})
w = w / w.sum()  # renormalize

# Allocate initial shares.
init_px = px.iloc[0]
shares = (capital * w) / init_px
cash = 0.0

# Determine rebalance dates. Threshold must be strictly AFTER \`date\` so the
# day right after a period boundary doesn't trigger an immediate second
# rebalance. \`offset(1)\` advances forward: when \`date\` is already at a
# period end, it jumps to the FOLLOWING period end (so candidate > date).
def next_threshold(date, kind):
    if kind == "monthly":
        offset = pd.offsets.MonthEnd(1)
    elif kind == "quarterly":
        offset = pd.offsets.QuarterEnd(1)
    elif kind == "yearly":
        offset = pd.offsets.YearEnd(1)
    else:
        return None
    return (pd.Timestamp(date) + offset).normalize()

equity_curve = []
last_pivot = px.index[0]
threshold = next_threshold(last_pivot, rebalance) if rebalance != "none" else None

for ts, row in px.iterrows():
    eq = float((shares * row).sum() + cash)
    equity_curve.append((str(ts.date()), eq))
    if threshold is not None and ts >= threshold:
        # rebalance
        target = (eq * w) / row
        shares = target
        cash = 0.0
        last_pivot = ts
        threshold = next_threshold(ts, rebalance)

ec = pd.Series([e for _, e in equity_curve], index=[d for d, _ in equity_curve])
final = float(ec.iloc[-1])
total_return = (final - capital) / capital
days = max(1, (px.index[-1] - px.index[0]).days)
years = days / 365.25
cagr = (final / capital) ** (1.0 / years) - 1.0 if years > 0 and final > 0 else 0.0

# Per-period returns from equity curve.
ec_vals = list(ec.values)
rets = []
for i in range(1, len(ec_vals)):
    if ec_vals[i - 1] > 0:
        rets.append((ec_vals[i] - ec_vals[i - 1]) / ec_vals[i - 1])
# Annualization factor must match the actual sampling frequency of the index.
# Hardcoding 252 understates vol/Sharpe when the portfolio includes 7d/week
# instruments (crypto) and the index spans ~365 obs/year. Derive empirically
# from the observed span so equity-only ≈ 252, crypto-only ≈ 365, mixed sits
# between.
span_days = max(1, (px.index[-1] - px.index[0]).days)
periods_per_year = (len(rets) / span_days) * 365.25 if span_days > 0 else 252.0
if len(rets) > 1:
    mean_r = sum(rets) / len(rets)
    var_r = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
    std_r = math.sqrt(var_r)
    ann_vol = std_r * math.sqrt(periods_per_year)
    ann_sharpe = (mean_r * periods_per_year) / ann_vol if ann_vol > 0 else 0.0
else:
    ann_vol = 0.0
    ann_sharpe = 0.0

peak = ec_vals[0] if ec_vals else capital
max_dd = 0.0
for v in ec_vals:
    if v > peak:
        peak = v
    if peak > 0:
        dd = (peak - v) / peak
        if dd > max_dd:
            max_dd = dd

# Per-ticker contribution: buy-and-hold from start of overlapping window.
contributions = []
init_alloc = capital * w
for t in present:
    series = px[t]
    s_init = float(series.iloc[0])
    s_end = float(series.iloc[-1])
    asset_return = (s_end - s_init) / s_init if s_init > 0 else 0.0
    pnl = float(init_alloc[t]) * asset_return
    contributions.append({
        "ticker": t,
        "weight": float(w[t]),
        "start_price": s_init,
        "end_price": s_end,
        "asset_return": asset_return,
        "pnl_dollars": pnl,
    })

contributions.sort(key=lambda c: c["pnl_dollars"], reverse=True)

result = {
    "ok": True,
    "currency": target_ccy,
    "starting_capital": capital,
    "ending_equity": final,
    "total_return": total_return,
    "cagr": cagr,
    "annualized_volatility": ann_vol,
    "sharpe_ratio": ann_sharpe,
    "max_drawdown": max_dd,
    "annualization_periods_per_year": round(periods_per_year, 2),
    "rebalance": rebalance,
    "analytics_only": True,
    "production_eligible": False,
    "eligibility_reason": "Portfolio rebalancing path does not yet apply engine_v2 execution profiles/costs to rebalance trades.",
    "window_days": days,
    "start": str(px.index[0].date()),
    "end": str(px.index[-1].date()),
    "missing_tickers": missing,
    "ticker_currencies": ticker_ccy,
    "fx_converted": [t for t in present if ticker_ccy[t] != target_ccy],
    "best": contributions[0] if contributions else None,
    "worst": contributions[-1] if contributions else None,
    "contributions": contributions,
}

print(json.dumps(result))
`

function computeDateRange(duration: string): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end)
  const m = /^(\d+)([dwmy])$/.exec(duration.trim().toLowerCase())
  if (m) {
    const n = parseInt(m[1], 10)
    switch (m[2]) {
      case "d":
        start.setDate(start.getDate() - n)
        break
      case "w":
        start.setDate(start.getDate() - n * 7)
        break
      case "m":
        // setDate(1) BEFORE subtracting months so a Mar-31 anchor doesn't
        // become Mar-3 ("Feb 31" rolls forward to Mar 3 in JS Date math).
        start.setDate(1)
        start.setMonth(start.getMonth() - n)
        break
      case "y":
        start.setDate(1)
        start.setFullYear(start.getFullYear() - n)
        break
    }
  } else {
    start.setDate(1)
    start.setFullYear(start.getFullYear() - 5)
  }
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`
}

function fmtMoney(x: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(x)
  } catch {
    return `${currency} ${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

export const PortfolioBacktestTool = Tool.define(
  "finny_portfolio_backtest",
  Effect.succeed({
    description:
      "Backtest a multi-asset portfolio (stocks, ETFs, crypto, bonds) defined by ticker + weight pairs. Fetches historical prices via yfinance, simulates buy-and-hold or periodic rebalancing, and returns CAGR, Sharpe, max drawdown, annualized vol, and per-ticker contribution. Use after the portfolio_builder agent produces a plan.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await Effect.runPromise(
          ctx.ask({
            permission: "finny_portfolio_backtest",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          }),
        )

        const totalWeight = params.holdings.reduce((s, h) => s + h.weight, 0)
        if (totalWeight <= 0) {
          return {
            title: "Portfolio backtest failed",
            output: "All weights are zero — nothing to backtest.",
            metadata: {},
          }
        }
        // Reject inputs that don't sum to ~1.0. The Python script renormalizes
        // anyway, but silent rescaling makes results surprising to the caller
        // (a model passing [0.3, 0.4, 0.5] would get a 1.2x-scaled portfolio
        // back without any signal). 0.02 tolerance covers float rounding.
        if (Math.abs(totalWeight - 1) > 0.02) {
          return {
            title: "Portfolio backtest failed",
            output:
              `Holdings weights must sum to ~1.0, got ${totalWeight.toFixed(3)}. ` +
              `Pass normalized weights (each as a fraction of the total portfolio) ` +
              `instead of relying on implicit rescaling.`,
            metadata: { error: "weights_not_normalized", total: totalWeight },
          }
        }

        const { start, end } = computeDateRange(params.duration)

        let pythonCmd: string
        try {
          const env = await resolveSessionPythonEnv(ctx.sessionID, [
            { spec: "yfinance", importCheck: "yfinance" },
            { spec: "pandas", importCheck: "pandas" },
          ])
          pythonCmd = env.python
        } catch (e: any) {
          return {
            title: "Python env failed",
            output: e?.message ?? "Failed to set up the managed Python environment.",
            metadata: { error: "python_env" },
          }
        }

        let tmpDir: string | undefined
        try {
          tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-pf-backtest-"))
          const scriptPath = path.join(tmpDir, "pf_backtest.py")
          const configPath = path.join(tmpDir, "config.json")
          await fs.writeFile(scriptPath, PORTFOLIO_BACKTEST_PY)
          await fs.writeFile(
            configPath,
            JSON.stringify(
              {
                holdings: params.holdings.map((h) => ({ ticker: h.ticker.trim(), weight: h.weight })),
                capital: params.capital,
                start,
                end,
                rebalance: params.rebalance,
                currency: params.currency,
              },
              null,
              2,
            ),
          )

          const result = await Process.run([pythonCmd, scriptPath, "--config", configPath], {
            cwd: tmpDir,
            nothrow: true,
            timeout: 120_000,
            abort: ctx.abort,
          })

          if (result.code !== 0) {
            const stderr = result.stderr.toString().trim()
            return {
              title: "Portfolio backtest failed",
              output: `Backtest failed:\n${stderr || "unknown error"}`,
              metadata: {},
            }
          }

          const stdout = result.stdout.toString().trim()
          const lastLine = stdout.split("\n").filter(Boolean).pop() ?? "{}"
          let parsed: any
          try {
            parsed = JSON.parse(lastLine)
          } catch {
            return {
              title: "Portfolio backtest failed",
              output: `Could not parse backtest output:\n${stdout}`,
              metadata: {},
            }
          }

          if (!parsed.ok) {
            return {
              title: "Portfolio backtest failed",
              output: parsed.error ?? "Unknown error",
              metadata: {},
            }
          }

          const ccy = params.currency
          const lines: string[] = []
          lines.push(`Portfolio Backtest — ${parsed.start} → ${parsed.end} (${parsed.window_days} days)`)
          lines.push(`Currency: ${ccy} · Rebalance: ${parsed.rebalance}`)
          if (parsed.analytics_only) {
            lines.push("Eligibility: analytics-only; not production eligible until rebalance trades use engine_v2 execution profiles/costs.")
          }
          lines.push("")
          lines.push(`Starting Capital: ${fmtMoney(parsed.starting_capital, ccy)}`)
          lines.push(`Ending Equity:    ${fmtMoney(parsed.ending_equity, ccy)}`)
          lines.push(`Total Return:     ${fmtPct(parsed.total_return)}`)
          lines.push(`CAGR:             ${fmtPct(parsed.cagr)}`)
          lines.push(
            `Annualized Vol:   ${fmtPct(parsed.annualized_volatility)} ` +
              `(annualizing at ~${(parsed.annualization_periods_per_year ?? 252).toFixed(0)} obs/yr)`,
          )
          lines.push(`Sharpe (rf=0):    ${parsed.sharpe_ratio.toFixed(2)}`)
          lines.push(`Max Drawdown:     ${fmtPct(parsed.max_drawdown)}`)
          if (parsed.fx_converted && parsed.fx_converted.length > 0) {
            lines.push("")
            lines.push(`FX-converted to ${ccy}: ${parsed.fx_converted.join(", ")}`)
          }
          if (parsed.missing_tickers && parsed.missing_tickers.length > 0) {
            lines.push("")
            lines.push(`⚠ Missing data for: ${parsed.missing_tickers.join(", ")} — weights renormalized.`)
          }
          lines.push("")
          lines.push("Per-ticker contribution:")
          for (const c of parsed.contributions ?? []) {
            lines.push(
              `  ${c.ticker.padEnd(10)} w=${(c.weight * 100).toFixed(1)}%  ` +
                `ret=${fmtPct(c.asset_return).padStart(8)}  pnl=${fmtMoney(c.pnl_dollars, ccy)}`,
            )
          }

          return {
            title: `Portfolio backtest — ${fmtPct(parsed.total_return)} over ${params.duration}`,
            output: lines.join("\n"),
            metadata: parsed,
          }
        } finally {
          if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
          }
        }
      }),
  }),
)
