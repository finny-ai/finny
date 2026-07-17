import fs from "fs/promises"
import path from "path"
import { resolveFinnyHome } from "@finny-ai/core/prefs"
import { Log } from "@/util/log"

const log = Log.create({ service: "native-hedge-ledger" })

const MAX_BATCH = 50
const MAX_BUFFER = 5_000
const FLUSH_DEBOUNCE_MS = 1_000
const DEFAULT_CONVEX_URL = "https://spotted-oyster-91.convex.site/ingest/native-hedge-live"

export type NativeHedgeLiveEventType =
  | "run.started"
  | "bar.seen"
  | "decision.made"
  | "order.intent"
  | "order.submitted"
  | "order.filled"
  | "order.rejected"
  | "equity.snapshot"
  | "position.snapshot"
  | "risk.decision"
  | "reconciliation"
  | "log"
  | "run.stopped"

export interface NativeHedgeLiveEventInput {
  runId: string
  eventType: NativeHedgeLiveEventType
  timestamp?: number
  sequence?: number
  eventId?: string
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
  payload?: Record<string, unknown>
}

export interface NativeHedgeLiveEvent extends NativeHedgeLiveEventInput {
  eventId: string
  timestamp: number
  sequence: number
  source: "finny-live-runner"
}

type Env = NodeJS.ProcessEnv

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushInProgress: Promise<void> | undefined
const buffer: NativeHedgeLiveEvent[] = []
const inFlight = new Set<Promise<unknown>>()
const pendingWrites = new Set<Promise<unknown>>()
const sequences = new Map<string, number>()

function truthyFlag(value: string | undefined) {
  return value === "1"
}

function endpoint(env: Env = process.env) {
  return env.FINNY_NATIVE_HEDGE_CONVEX_URL?.trim() || DEFAULT_CONVEX_URL
}

function secret(env: Env = process.env) {
  return env.FINNY_NATIVE_HEDGE_SECRET?.trim()
}

function spoolDir(env: Env = process.env) {
  const configured = env.FINNY_NATIVE_HEDGE_SPOOL_DIR?.trim()
  if (configured) return configured
  return path.join(resolveFinnyHome({ env }).path, "native-hedge-live-ledger")
}

function safeRunId(runId: string) {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function spoolPath(runId: string, env: Env = process.env) {
  return path.join(spoolDir(env), `${safeRunId(runId)}.jsonl`)
}

function nextSequence(runId: string) {
  const next = (sequences.get(runId) ?? 0) + 1
  sequences.set(runId, next)
  return next
}

function normalize(input: NativeHedgeLiveEventInput): NativeHedgeLiveEvent {
  const sequence = input.sequence ?? nextSequence(input.runId)
  return {
    ...input,
    eventId: input.eventId ?? `${input.runId}:${sequence}`,
    timestamp: input.timestamp ?? Date.now(),
    sequence,
    source: "finny-live-runner",
    payload: input.payload ?? {},
  }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flush()
  }, FLUSH_DEBOUNCE_MS)
  if (typeof flushTimer.unref === "function") flushTimer.unref()
}

function remainingMs(deadline: number) {
  return Math.max(0, deadline - Date.now())
}

function requeue(batch: NativeHedgeLiveEvent[]) {
  buffer.unshift(...batch)
  while (buffer.length > MAX_BUFFER) buffer.pop()
  scheduleFlush()
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}

async function appendSpool(event: NativeHedgeLiveEvent, env: Env = process.env) {
  const file = spoolPath(event.runId, env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(event) + "\n", "utf8")
}

function enqueueAfterSpool(event: NativeHedgeLiveEvent, env: Env = process.env) {
  const write = appendSpool(event, env)
    .then(() => {
      if (buffer.length >= MAX_BUFFER) buffer.shift()
      buffer.push(event)
      if (buffer.length >= MAX_BATCH) void flush()
      else scheduleFlush()
    })
    .catch((err) => {
      log.warn("native hedge event spool failed", {
        runId: event.runId,
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => pendingWrites.delete(write))
  pendingWrites.add(write)
}

async function doFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (buffer.length === 0) return
  const url = endpoint()
  const token = secret()
  if (!url || !token) return
  const batch = buffer.splice(0, Math.min(buffer.length, MAX_BATCH))
  const post = postBatch(url, token, batch).finally(() => inFlight.delete(post))
  inFlight.add(post)
  if (buffer.length > 0) scheduleFlush()
}

async function postBatch(url: string, token: string, batch: NativeHedgeLiveEvent[]): Promise<void> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-finny-native-hedge-secret": token,
      },
      body: JSON.stringify({ batch }),
    })
    if (!res.ok) {
      log.warn("native hedge ingest rejected", { status: res.status, count: batch.length })
      if (retryableStatus(res.status)) requeue(batch)
    }
  } catch (err) {
    log.warn("native hedge ingest failed", {
      error: err instanceof Error ? err.message : String(err),
      count: batch.length,
    })
    requeue(batch)
  }
}

export function flagEnabled(env: Env = process.env) {
  return truthyFlag(env.FINNY_AI_NATIVE_HEDGE)
}

export function enabled(env: Env = process.env) {
  return flagEnabled(env) && !!endpoint(env) && !!secret(env)
}

export function disabledReason(env: Env = process.env) {
  if (!flagEnabled(env)) return "FINNY_AI_NATIVE_HEDGE is not 1"
  if (!endpoint(env)) return "FINNY_NATIVE_HEDGE_CONVEX_URL is empty"
  if (!secret(env)) return "FINNY_NATIVE_HEDGE_SECRET is empty"
  return undefined
}

export function spoolPathForRun(runId: string, env: Env = process.env) {
  return spoolPath(runId, env)
}

export function record(input: NativeHedgeLiveEventInput, env: Env = process.env): NativeHedgeLiveEvent | undefined {
  if (!enabled(env)) return undefined
  const event = normalize(input)
  enqueueAfterSpool(event, env)
  return event
}

export async function flush(): Promise<void> {
  if (flushInProgress) return flushInProgress
  flushInProgress = doFlush().finally(() => {
    flushInProgress = undefined
  })
  return flushInProgress
}

export async function drain(timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  if (pendingWrites.size > 0) {
    await Promise.race([
      Promise.allSettled(Array.from(pendingWrites)),
      new Promise((resolve) => setTimeout(resolve, remainingMs(deadline))),
    ])
  }
  while (buffer.length > 0 && remainingMs(deadline) > 0) {
    const before = buffer.length
    await flush().catch(() => {})
    if (inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled(Array.from(inFlight)),
        new Promise((resolve) => setTimeout(resolve, remainingMs(deadline))),
      ])
    }
    if (buffer.length >= before) break
  }
  if (inFlight.size === 0) return
  await Promise.race([
    Promise.allSettled(Array.from(inFlight)),
    new Promise((resolve) => setTimeout(resolve, remainingMs(deadline))),
  ])
}

export function _spoolPathForTests(runId: string, env: Env = process.env) {
  return spoolPath(runId, env)
}

export function _setFetchForTests(next: typeof fetch) {
  fetchImpl = next
}

export function _resetForTests() {
  fetchImpl = globalThis.fetch.bind(globalThis)
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
  flushInProgress = undefined
  buffer.length = 0
  inFlight.clear()
  pendingWrites.clear()
  sequences.clear()
}

export function _eventForTests(input: NativeHedgeLiveEventInput) {
  return normalize(input)
}

export function _bufferLengthForTests() {
  return buffer.length
}

export * as NativeHedgeLedger from "./native-hedge-ledger"
