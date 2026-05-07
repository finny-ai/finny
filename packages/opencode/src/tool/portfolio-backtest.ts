import z from "zod"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Process } from "@/util/process"

const parameters = z.object({
  holdings: z
    .array(
      z.object({
        ticker: z
          .string()
          .describe(
            "yfinance-compatible ticker. Equities use the bare symbol (VOO, AAPL, VFV.TO). Crypto uses dash form (BTC-USD, ETH-USD). Foreign listings use suffixes (e.g. VFV.TO for TSX).",
          ),
        weight: z.number().min(0).max(1).describe("Portfolio weight as a decimal (0–1). All weights must sum to ~1.0."),
        assetClass: z.enum(["stock", "etf", "crypto", "bond", "cash"]).optional(),
      }),
    )
    .min(1)
    .describe("Holdings in the portfolio with their target weights."),
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
})

const PORTFOLIO_BACKTEST_PY = String.raw`
import sys, json, argparse, math, subprocess
from pathlib import Path

try:
    import yfinance as yf
    import pandas as pd
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "yfinance", "pandas"])
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

w = pd.Series({t: weights[t] for t in present})
w = w / w.sum()  # renormalize

# Allocate initial shares.
init_px = px.iloc[0]
shares = (capital * w) / init_px
cash = 0.0

# Determine rebalance dates.
def next_threshold(date, kind):
    if kind == "monthly":
        return (date.replace(day=1) + pd.offsets.MonthEnd(1)).normalize()
    if kind == "quarterly":
        return (date + pd.offsets.QuarterEnd(0)).normalize()
    if kind == "yearly":
        return (date + pd.offsets.YearEnd(0)).normalize()
    return None

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

# Daily returns from equity curve.
ec_vals = list(ec.values)
rets = []
for i in range(1, len(ec_vals)):
    if ec_vals[i - 1] > 0:
        rets.append((ec_vals[i] - ec_vals[i - 1]) / ec_vals[i - 1])
if len(rets) > 1:
    mean_r = sum(rets) / len(rets)
    var_r = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
    std_r = math.sqrt(var_r)
    ann_vol = std_r * math.sqrt(252)
    ann_sharpe = (mean_r * 252) / ann_vol if ann_vol > 0 else 0.0
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
    "starting_capital": capital,
    "ending_equity": final,
    "total_return": total_return,
    "cagr": cagr,
    "annualized_volatility": ann_vol,
    "sharpe_ratio": ann_sharpe,
    "max_drawdown": max_dd,
    "rebalance": rebalance,
    "window_days": days,
    "start": str(px.index[0].date()),
    "end": str(px.index[-1].date()),
    "missing_tickers": missing,
    "best": contributions[0] if contributions else None,
    "worst": contributions[-1] if contributions else None,
    "contributions": contributions,
}

print(json.dumps(result))
`

function computeDateRange(duration: string): { start: string; end: string } {
  const end = new Date()
  const start = new Date()
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
        start.setMonth(start.getMonth() - n)
        break
      case "y":
        start.setFullYear(start.getFullYear() - n)
        break
    }
  } else {
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

function fmtUsd(x: number): string {
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const PortfolioBacktestTool = Tool.define(
  "finny_portfolio_backtest",
  Effect.succeed({
    description:
      "Backtest a multi-asset portfolio (stocks, ETFs, crypto, bonds) defined by ticker + weight pairs. Fetches historical prices via yfinance, simulates buy-and-hold or periodic rebalancing, and returns CAGR, Sharpe, max drawdown, annualized vol, and per-ticker contribution. Use after the portfolio_builder agent produces a plan.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_portfolio_backtest",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const totalWeight = params.holdings.reduce((s, h) => s + h.weight, 0)
        if (totalWeight <= 0) {
          return {
            title: "Portfolio backtest failed",
            output: "All weights are zero — nothing to backtest.",
            metadata: {},
          }
        }

        const { start, end } = computeDateRange(params.duration)

        let pythonCmd = "python3"
        try {
          await Process.run(["python3", "--version"])
        } catch {
          try {
            await Process.run(["python", "--version"])
            pythonCmd = "python"
          } catch {
            return {
              title: "Portfolio backtest failed",
              output: "Python 3 not found. Install Python 3 (e.g. brew install python3) and try again.",
              metadata: {},
            }
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
                holdings: params.holdings.map((h) => ({ ticker: h.ticker, weight: h.weight })),
                capital: params.capital,
                start,
                end,
                rebalance: params.rebalance,
              },
              null,
              2,
            ),
          )

          const result = await Process.run([pythonCmd, scriptPath, "--config", configPath], {
            cwd: tmpDir,
            nothrow: true,
            timeout: 120_000,
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

          const lines: string[] = []
          lines.push(`Portfolio Backtest — ${parsed.start} → ${parsed.end} (${parsed.window_days} days)`)
          lines.push(`Rebalance: ${parsed.rebalance}`)
          lines.push("")
          lines.push(`Starting Capital: ${fmtUsd(parsed.starting_capital)}`)
          lines.push(`Ending Equity:    ${fmtUsd(parsed.ending_equity)}`)
          lines.push(`Total Return:     ${fmtPct(parsed.total_return)}`)
          lines.push(`CAGR:             ${fmtPct(parsed.cagr)}`)
          lines.push(`Annualized Vol:   ${fmtPct(parsed.annualized_volatility)}`)
          lines.push(`Sharpe (rf=0):    ${parsed.sharpe_ratio.toFixed(2)}`)
          lines.push(`Max Drawdown:     ${fmtPct(parsed.max_drawdown)}`)
          if (parsed.missing_tickers && parsed.missing_tickers.length > 0) {
            lines.push("")
            lines.push(`⚠ Missing data for: ${parsed.missing_tickers.join(", ")} — weights renormalized.`)
          }
          lines.push("")
          lines.push("Per-ticker contribution:")
          for (const c of parsed.contributions ?? []) {
            lines.push(
              `  ${c.ticker.padEnd(10)} w=${(c.weight * 100).toFixed(1)}%  ` +
                `ret=${fmtPct(c.asset_return).padStart(8)}  pnl=${fmtUsd(c.pnl_dollars)}`,
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
