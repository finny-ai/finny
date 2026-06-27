import { Telemetry } from "./gate"
import { TelemetrySink } from "./sink"

export interface EmitInput {
  eventType: string
  payload: Record<string, any>
  algorithmId?: string
  source?: string
}

const ARTIFACT_FIELDS: Array<[key: string, artifactName: string, artifactType: string]> = [
  ["code", "strategy.py", "strategy_code"],
  ["config", "config.json", "config"],
  ["backtestCode", "backtest.py", "backtest_code"],
  ["reasoning", "reasoning.md", "markdown"],
  ["mission", "mission.md", "markdown"],
  ["prefs", "prefs.md", "markdown"],
  ["decisions", "decisions.md", "markdown"],
]

// Large artifact bodies (strategy code, config, reasoning, etc.) are shipped as
// dedicated `artifact` records. Strip them from the generic `event` payload so
// the event stream stays metadata-only and we don't duplicate big blobs.
const ARTIFACT_KEYS = new Set(ARTIFACT_FIELDS.map(([key]) => key))

function eventPayload(input: EmitInput): Record<string, any> {
  const payload: Record<string, any> = {}
  for (const [key, value] of Object.entries(input.payload)) {
    if (ARTIFACT_KEYS.has(key)) continue
    payload[key] = value
  }
  if (input.algorithmId) payload.algorithmId = input.algorithmId
  return payload
}

function enqueueArtifacts(input: EmitInput, timeCreated: number) {
  if (input.eventType !== "algorithm.saved" && input.eventType !== "algorithm.config_patched") return
  for (const [key, artifactName, artifactType] of ARTIFACT_FIELDS) {
    const content = input.payload[key]
    if (typeof content !== "string" || content.length === 0) continue
    TelemetrySink.enqueue({
      kind: "artifact",
      artifactType,
      artifactName,
      algorithmId: input.algorithmId ?? input.payload.algorithmId,
      algorithmName: input.payload.name,
      version: typeof input.payload.version === "number" ? input.payload.version : undefined,
      content,
      metadata: {
        eventType: input.eventType,
        saveMode: input.payload.saveMode,
        language: input.payload.language,
        status: input.payload.status,
        description: input.payload.description,
      },
      time_created: timeCreated,
    })
  }
}

function enqueueStructuredEvent(input: EmitInput, timeCreated: number) {
  const algorithmId = input.algorithmId ?? input.payload.algorithmId
  if (input.eventType.startsWith("backtest.")) {
    TelemetrySink.enqueue({
      kind: "backtest",
      eventType: input.eventType,
      algorithmId,
      duration: input.payload.duration,
      interval: input.payload.interval,
      capital: input.payload.capital,
      status: input.eventType.endsWith(".completed")
        ? "completed"
        : input.eventType.endsWith(".failed")
          ? "failed"
          : (input.payload.status ?? input.eventType.split(".").pop()),
      metrics: {
        productLabel: input.payload.productLabel,
        runKind: input.payload.runKind,
        engineVersion: input.payload.engineVersion,
        schemaVersion: input.payload.schemaVersion,
        totalReturn: input.payload.totalReturn,
        maxDrawdown: input.payload.maxDrawdown,
        sharpeRatio: input.payload.sharpeRatio,
        totalTrades: input.payload.totalTrades,
        eligibilityStatus: input.payload.eligibilityStatus,
        diagnostics: input.payload.diagnostics,
      },
      payload: input.payload,
      time_created: timeCreated,
    })
  }
  // The whole live.* lifecycle (started / equity_snapshot / order_fill / log /
  // stopped) lands in telemetryLiveOrders as an append-only stream keyed by
  // runId, not just order fills. Fields not relevant to a given eventType stay
  // undefined and are dropped server-side.
  if (input.eventType.startsWith("live.")) {
    const p = input.payload
    TelemetrySink.enqueue({
      kind: "live_order",
      eventType: input.eventType,
      algorithmId,
      runId: p.runId,
      orderId: p.order_id ?? p.orderId,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      price: p.price,
      status: p.status,
      brokerTimestamp: p.ts,
      brokerage: p.brokerage,
      mode: p.mode,
      equity: p.equity,
      cash: p.cash,
      logLevel: p.level,
      logMessage: p.message,
      payload: p,
      time_created: timeCreated,
    })
  }
}

export function emit(input: EmitInput): void {
  if (!Telemetry.enabled()) return
  const timeCreated = Date.now()
  // Live log lines are high-volume and fully captured in telemetryLiveOrders;
  // keep them out of the generic event firehose to avoid doubling rows.
  if (input.eventType !== "live.log") {
    TelemetrySink.enqueue({
      kind: "event",
      eventType: input.eventType,
      payload: eventPayload(input),
      source: input.source,
      time_created: timeCreated,
    })
  }
  enqueueArtifacts(input, timeCreated)
  enqueueStructuredEvent(input, timeCreated)
}
