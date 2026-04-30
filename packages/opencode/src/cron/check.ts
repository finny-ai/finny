import { Log } from "../util/log"
import { Job } from "./job"
import { AlpacaData } from "./alpaca-data"

export namespace Check {
  const log = Log.create({ service: "cron.check" })

  export type Result = {
    fired: boolean
    note: string
    summary?: string
  }

  function compare(actual: number, op: Job.CheckOp, target: number): boolean {
    switch (op) {
      case ">":
        return actual > target
      case ">=":
        return actual >= target
      case "<":
        return actual < target
      case "<=":
        return actual <= target
      case "%change":
        // %change is a value-comparator: actual >= target if target ≥ 0,
        // actual ≤ target if target < 0. e.g. value=-2 fires on a ≥2% drop.
        return target >= 0 ? actual >= target : actual <= target
    }
  }

  export async function evaluate(job: Job.Schema): Promise<Result> {
    if (job.kind !== "check") return { fired: false, note: "job is not a check job" }
    const check = job.check

    try {
      if (check.type === "price") {
        const snap = await AlpacaData.snapshot(check.symbol)
        if (!snap) return { fired: false, note: `no Alpaca snapshot for ${check.symbol}` }
        const actual = check.op === "%change" ? snap.pctChange : snap.price
        const fired = compare(actual, check.op, check.value)
        const summary = `${check.symbol} price=${snap.price.toFixed(2)} (${snap.pctChange >= 0 ? "+" : ""}${snap.pctChange.toFixed(2)}% today)`
        return { fired, note: `${summary}; threshold ${check.op} ${check.value}`, summary }
      }

      if (check.type === "pnl") {
        const acc = await AlpacaData.account()
        if (!acc) return { fired: false, note: "no Alpaca account available" }
        const actual = check.op === "%change" ? acc.dailyPctChange : acc.equity
        const fired = compare(actual, check.op, check.value)
        const summary = `equity=$${acc.equity.toFixed(0)} (${acc.dailyPctChange >= 0 ? "+" : ""}${acc.dailyPctChange.toFixed(2)}% today)`
        return { fired, note: `${summary}; threshold ${check.op} ${check.value}`, summary }
      }

      // position — schema rejects %change for this kind, so all ops are absolute.
      const qty = await AlpacaData.position(check.symbol)
      if (qty === null) return { fired: false, note: `position lookup failed for ${check.symbol}` }
      const fired = compare(qty, check.op, check.value)
      const summary = `${check.symbol} position=${qty}`
      return { fired, note: `${summary}; threshold ${check.op} ${check.value}`, summary }
    } catch (err) {
      log.warn("check.evaluate.failed", { jobId: job.id, err: String(err) })
      return { fired: false, note: `evaluator error: ${String(err).slice(0, 150)}` }
    }
  }

  export function withinCooldown(job: Job.Schema, now: number): boolean {
    if (job.kind !== "check") return false
    if (!job.lastFiredAt) return false
    const cooldown = (job.check.cooldownMinutes ?? 60) * 60_000
    return now - job.lastFiredAt < cooldown
  }
}
