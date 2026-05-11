import { Algorithm } from "@/algorithm"
import { parseConfig } from "@/algorithm/strategy-params"
import { AlpacaData } from "./alpaca-data"
import { Job } from "./job"
import { WatcherState } from "./watcher-state"

export namespace WatcherEvaluator {
  const MATERIAL_PCT = 2
  const POSITION_QTY_DELTA = 1e-9

  export type Decision =
    | { kind: "skip"; note: string }
    | { kind: "run"; note: string }
    | { kind: "unavailable"; note: string }

  function pctChange(current?: number, previous?: number) {
    if (current === undefined || previous === undefined || previous === 0) return 0
    return Math.abs(((current - previous) / previous) * 100)
  }

  function positionChanged(current?: number, previous?: number) {
    if (current === undefined || previous === undefined) return false
    const currentFlat = Math.abs(current) <= POSITION_QTY_DELTA
    const previousFlat = Math.abs(previous) <= POSITION_QTY_DELTA
    if (currentFlat !== previousFlat) return true
    return Math.abs(current - previous) > POSITION_QTY_DELTA
  }

  export async function evaluate(job: Job.Schema): Promise<Decision> {
    if (job.kind !== "prompt" || job.prompt.agent !== "watcher" || !job.parentSessionID) {
      return { kind: "run", note: "not a session watcher" }
    }

    // The watcher_state row is upserted at schedule_subagent time with the
    // canonical algorithmID/Name. If it's missing we cannot trust prompt-text
    // parsing as a fallback (formatting drift would silently auto-pause the
    // watcher), so report unavailable and let the failure path handle it.
    const state = WatcherState.get(job.id)
    if (!state) {
      return { kind: "unavailable", note: "watcher state missing — re-create the watcher" }
    }

    // Notes flag the user supplied at schedule time always force a full LLM
    // run. Use a multi-line-tolerant test so newlines in notes don't make it
    // look like the literal string "none".
    if (/^Notes:\s*(?!none\s*$)[\s\S]+/m.test(job.prompt.text)) {
      return { kind: "run", note: "watcher has notes" }
    }

    const algorithm = state.algorithmID
      ? await Algorithm.getById(state.algorithmID)
      : state.algorithmName
        ? await Algorithm.get(state.algorithmName)
        : null
    if (!algorithm) return { kind: "unavailable", note: "algorithm not found" }

    const config = parseConfig(algorithm.config)
    if (config.brokerage && config.brokerage !== "alpaca") {
      return { kind: "run", note: "non-alpaca watcher requires LLM context" }
    }
    if (!config.symbol) return { kind: "run", note: "missing symbol" }

    const [market, account, positionQty] = await Promise.all([
      AlpacaData.snapshot(config.symbol),
      AlpacaData.account(),
      AlpacaData.position(config.symbol),
    ])
    if (!market && !account && positionQty === null) {
      return { kind: "unavailable", note: "snapshot unavailable" }
    }

    const price = market?.price
    const equity = account?.equity
    const qty = positionQty ?? undefined
    const previousPrice = state.lastPrice ?? state.baselinePrice
    const previousEquity = state.lastEquity ?? state.baselineEquity
    const previousQty = state.lastPositionQty ?? state.baselinePositionQty
    const material =
      pctChange(price, previousPrice) >= MATERIAL_PCT ||
      pctChange(equity, previousEquity) >= MATERIAL_PCT ||
      positionChanged(qty, previousQty)

    WatcherState.recordSnapshot(job.id, {
      price,
      equity,
      positionQty: qty,
      material,
    })

    if (!previousPrice && !previousEquity && previousQty === undefined) {
      return { kind: "skip", note: "watcher baseline captured" }
    }
    return material ? { kind: "run", note: "material snapshot change" } : { kind: "skip", note: "no material change" }
  }
}
