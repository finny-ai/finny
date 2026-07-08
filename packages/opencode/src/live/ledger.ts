import { Log } from "@/util/log"
import type { BrokerKind, BrokerMode } from "./brokers"

const log = Log.create({ service: "live-ledger" })

const MAX_IN_FLIGHT = 8
const REQUEST_TIMEOUT_MS = 2_000
const MAX_STRING = 500
const MAX_POSITIONS = 20

type LedgerKind = "status" | "mark" | "fill" | "log"

type JsonRecord = Record<string, unknown>

function configuredUrl(): string | undefined {
  const value = process.env["FINNY_CONVEX_LEDGER_URL"]?.trim()
  return value || undefined
}

function configuredToken(): string | undefined {
  const value = process.env["FINNY_CONVEX_LEDGER_TOKEN"]?.trim()
  return value || undefined
}

function deploymentId(runId: string): string {
  const configured = process.env["FINNY_DEPLOYMENT_ID"]?.trim() || process.env["FINNY_RUNTIME_DEPLOYMENT_ID"]?.trim()
  return configured ? `${configured}:${runId}` : runId
}

function exchangeFor(kind: BrokerKind): string | undefined {
  if (kind === "binance") return "binance"
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function smallString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value
}

function compactRecord(input: unknown, limit = MAX_POSITIONS): Record<string, number> | undefined {
  if (!input || typeof input !== "object") return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, limit)) {
    const n = finiteNumber(value)
    if (n !== undefined) out[key] = n
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanObject<T extends JsonRecord>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
let warnedDrop = false
let warnedFailure = false
const inFlight = new Set<Promise<void>>()

async function post(url: string, body: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (typeof timer.unref === "function") timer.unref()
  const token = configuredToken()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["x-finny-ledger-token"] = token
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
    if (!res.ok) {
      log.warn("live ledger ingest rejected", { status: res.status })
    }
  } catch (err) {
    if (!warnedFailure) {
      warnedFailure = true
      log.warn("live ledger ingest failed (fire-and-forget)", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    clearTimeout(timer)
  }
}

function send(body: string): void {
  const url = configuredUrl()
  if (!url) return
  if (inFlight.size >= MAX_IN_FLIGHT) {
    if (!warnedDrop) {
      warnedDrop = true
      log.warn("live ledger event dropped - sender backlog is full", { maxInFlight: MAX_IN_FLIGHT })
    }
    return
  }
  const req = post(url, body).finally(() => inFlight.delete(req))
  inFlight.add(req)
}

export namespace LiveLedger {
  export interface RunContext {
    runId: string
    algorithmId: string
    algorithmName: string
    symbol: string
    interval: string
    brokerKind: BrokerKind
    mode?: BrokerMode
  }

  export interface EmitInput {
    seq: number
    kind: LedgerKind
    workerType?: string
    ts?: string | number
    status?: string
    reason?: string
    symbol?: string
    interval?: string
    order?: {
      order_id?: string
      side?: string
      qty?: number
      price?: number
      status?: string
      ts?: string
    }
    mark?: {
      timestamp?: string
      open?: number
      high?: number
      low?: number
      close?: number
      volume?: number
      cash?: number
      equity?: number
      positions?: Record<string, number>
    }
    log?: {
      level?: string
      message?: string
    }
  }

  export function emit(context: RunContext, input: EmitInput): void {
    if (!configuredUrl()) return
    const symbol = smallString(input.symbol) ?? context.symbol
    const event = cleanObject({
      eventId: `live:${context.runId}:${input.seq}:${input.kind}`,
      seq: input.seq,
      kind: input.kind,
      workerType: smallString(input.workerType),
      ts: input.ts ?? Date.now(),
      deploymentId: deploymentId(context.runId),
      runId: context.runId,
      algorithmId: context.algorithmId,
      algorithmName: smallString(context.algorithmName),
      brokerKind: context.brokerKind,
      mode: context.mode,
      exchange: exchangeFor(context.brokerKind),
      symbol,
      interval: smallString(input.interval) ?? context.interval,
      status: smallString(input.status),
      reason: smallString(input.reason),
      order: input.order
        ? cleanObject({
            orderId: smallString(input.order.order_id),
            side: smallString(input.order.side),
            qty: finiteNumber(input.order.qty),
            price: finiteNumber(input.order.price),
            status: smallString(input.order.status),
            brokerTimestamp: smallString(input.order.ts),
          })
        : undefined,
      mark: input.mark
        ? cleanObject({
            timestamp: smallString(input.mark.timestamp),
            open: finiteNumber(input.mark.open),
            high: finiteNumber(input.mark.high),
            low: finiteNumber(input.mark.low),
            close: finiteNumber(input.mark.close),
            volume: finiteNumber(input.mark.volume),
            cash: finiteNumber(input.mark.cash),
            equity: finiteNumber(input.mark.equity),
            positions: compactRecord(input.mark.positions),
          })
        : undefined,
      log: input.log
        ? cleanObject({
            level: smallString(input.log.level),
            message: smallString(input.log.message),
          })
        : undefined,
    })

    send(
      JSON.stringify({
        schemaVersion: 1,
        source: "finny-live-runner",
        event,
      }),
    )
  }

  export function _setFetchForTests(next: typeof fetch): void {
    fetchImpl = next
  }
}
