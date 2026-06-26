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
      status: input.eventType.endsWith(".completed") ? "completed" : "failed",
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
  if (input.eventType === "live.order_fill") {
    TelemetrySink.enqueue({
      kind: "live_order",
      eventType: input.eventType,
      algorithmId,
      runId: input.payload.runId,
      orderId: input.payload.order_id ?? input.payload.orderId,
      symbol: input.payload.symbol,
      side: input.payload.side,
      qty: input.payload.qty,
      price: input.payload.price,
      status: input.payload.status,
      brokerTimestamp: input.payload.ts,
      payload: input.payload,
      time_created: timeCreated,
    })
  }
}

export function emit(input: EmitInput): void {
  if (!Telemetry.enabled()) return
  const timeCreated = Date.now()
  TelemetrySink.enqueue({
    kind: "event",
    eventType: input.eventType,
    payload: {
      ...input.payload,
      ...(input.algorithmId ? { algorithmId: input.algorithmId } : {}),
    },
    source: input.source,
    time_created: timeCreated,
  })
  enqueueArtifacts(input, timeCreated)
  enqueueStructuredEvent(input, timeCreated)
}
