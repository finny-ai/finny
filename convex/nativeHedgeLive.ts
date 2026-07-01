import { internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { MAX_NATIVE_HEDGE_BATCH } from "./nativeHedgeLiveValidation"

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function runStatus(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "run.started") return "running"
  if (eventType === "run.stopped") return "stopped"
  if (typeof payload.status === "string" && payload.status.trim().length > 0) return payload.status
  return undefined
}

function eventError(eventType: string, payload: Record<string, unknown>) {
  if (eventType !== "run.stopped") return undefined
  if (typeof payload.error === "string" && payload.error.trim().length > 0) return payload.error
  const reason = payload.reason
  if (typeof reason === "string" && reason.startsWith("exit_code_")) return reason
  if (reason === "crash") return "crash"
  return undefined
}

type NativeHedgeLiveEvent = {
  eventId: string
  runId: string
  eventType: string
  sequence: number
  timestamp: number
  source?: string
  algorithmId?: string
  algorithmName?: string
  symbol?: string
  interval?: string
  brokerage?: string
  mode?: string
  orderId?: string
  side?: string
  qty?: number
  price?: number
  status?: string
  why?: string
  features?: unknown
  payload?: unknown
}

function eventPayload(event: NativeHedgeLiveEvent) {
  return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {}
}

async function hasEvent(ctx: any, eventId: string) {
  return !!(await ctx.db
    .query("nativeHedgeLiveEvents")
    .withIndex("by_eventId", (q: any) => q.eq("eventId", eventId))
    .unique())
}

async function findRun(ctx: any, runId: string) {
  return await ctx.db
    .query("nativeHedgeLiveRuns")
    .withIndex("by_runId", (q: any) => q.eq("runId", runId))
    .unique()
}

function runInsert(event: NativeHedgeLiveEvent, payload: Record<string, unknown>, now: number) {
  return {
    runId: event.runId,
    algorithmId: event.algorithmId,
    algorithmName: event.algorithmName,
    symbol: event.symbol,
    interval: event.interval,
    brokerage: event.brokerage,
    mode: event.mode,
    status: runStatus(event.eventType, payload) ?? "running",
    startedAt: event.eventType === "run.started" ? event.timestamp : undefined,
    stoppedAt: event.eventType === "run.stopped" ? event.timestamp : undefined,
    lastEventAt: event.timestamp,
    error: eventError(event.eventType, payload),
    time_created: now,
    time_updated: now,
  }
}

function runPatch(event: NativeHedgeLiveEvent, payload: Record<string, unknown>, existingRun: any, now: number) {
  return {
    algorithmId: event.algorithmId ?? existingRun.algorithmId,
    algorithmName: event.algorithmName ?? existingRun.algorithmName,
    symbol: event.symbol ?? existingRun.symbol,
    interval: event.interval ?? existingRun.interval,
    brokerage: event.brokerage ?? existingRun.brokerage,
    mode: event.mode ?? existingRun.mode,
    status: runStatus(event.eventType, payload) ?? existingRun.status,
    stoppedAt: event.eventType === "run.stopped" ? event.timestamp : existingRun.stoppedAt,
    lastEventAt: event.timestamp,
    error: eventError(event.eventType, payload) ?? existingRun.error,
    time_updated: now,
  }
}

function eventInsert(event: NativeHedgeLiveEvent, payload: Record<string, unknown>, now: number) {
  return {
    eventId: event.eventId,
    runId: event.runId,
    eventType: event.eventType,
    sequence: event.sequence,
    timestamp: event.timestamp,
    source: optionalString(event.source),
    algorithmId: event.algorithmId,
    symbol: event.symbol,
    orderId: event.orderId,
    side: event.side,
    qty: event.qty,
    price: event.price,
    status: event.status,
    why: event.why,
    features: event.features,
    payload,
    time_created: now,
  }
}

async function upsertRun(ctx: any, event: NativeHedgeLiveEvent, payload: Record<string, unknown>, now: number) {
  const existingRun = await findRun(ctx, event.runId)
  if (existingRun) {
    await ctx.db.patch(existingRun._id, runPatch(event, payload, existingRun, now))
  } else {
    await ctx.db.insert("nativeHedgeLiveRuns", runInsert(event, payload, now))
  }
}

async function ingestEvent(ctx: any, event: NativeHedgeLiveEvent, now: number) {
  if (await hasEvent(ctx, event.eventId)) return "duplicate"
  const payload = eventPayload(event)
  await upsertRun(ctx, event, payload, now)
  await ctx.db.insert("nativeHedgeLiveEvents", eventInsert(event, payload, now))
  return "accepted"
}

export const ingest = internalMutation({
  args: {
    batch: v.array(
      v.object({
        eventId: v.string(),
        runId: v.string(),
        eventType: v.string(),
        sequence: v.number(),
        timestamp: v.number(),
        source: v.optional(v.string()),
        algorithmId: v.optional(v.string()),
        algorithmName: v.optional(v.string()),
        symbol: v.optional(v.string()),
        interval: v.optional(v.string()),
        brokerage: v.optional(v.string()),
        mode: v.optional(v.string()),
        orderId: v.optional(v.string()),
        side: v.optional(v.string()),
        qty: v.optional(v.number()),
        price: v.optional(v.number()),
        status: v.optional(v.string()),
        why: v.optional(v.string()),
        features: v.optional(v.any()),
        payload: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.batch.length === 0 || args.batch.length > MAX_NATIVE_HEDGE_BATCH) {
      return { ok: false as const, error_code: "invalid_batch" }
    }

    let accepted = 0
    let duplicates = 0
    const now = Date.now()

    for (const event of args.batch) {
      const result = await ingestEvent(ctx, event, now)
      if (result === "duplicate") duplicates++
      else accepted++
    }

    return { ok: true as const, accepted, duplicates }
  },
})
