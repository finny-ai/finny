import { Duration, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import { EffectLogger } from "@/effect/logger"
import { Flag } from "@/flag/flag"
import { CHANNEL, VERSION } from "@/installation/meta"

export namespace Observability {
  const base = Flag.OTEL_EXPORTER_OTLP_ENDPOINT ?? Flag.OPENCODE_TELEMETRY_URL
  export const enabled = !!base

  const resource = {
    serviceName: "opencode",
    serviceVersion: VERSION,
    attributes: {
      "deployment.environment.name": CHANNEL === "local" ? "local" : CHANNEL,
      "opencode.client": Flag.OPENCODE_CLIENT,
    },
  }

  const headers = parseHeaders(Flag.OTEL_EXPORTER_OTLP_HEADERS) ??
    (Flag.OPENCODE_TELEMETRY_TOKEN ? { Authorization: `Bearer ${Flag.OPENCODE_TELEMETRY_TOKEN}` } : undefined)

  export const layer = !base
    ? EffectLogger.layer
    : Otlp.layerJson({
        baseUrl: base,
        loggerExportInterval: Duration.seconds(1),
        loggerMergeWithExisting: true,
        resource,
        headers,
      }).pipe(Layer.provide(EffectLogger.layer), Layer.provide(FetchHttpClient.layer))

  function parseHeaders(input: string | undefined) {
    if (!input) return
    return input.split(",").reduce(
      (acc, item) => {
        const index = item.indexOf("=")
        if (index === -1) return acc
        const key = item.slice(0, index).trim()
        const value = item.slice(index + 1).trim()
        if (key) acc[key] = value
        return acc
      },
      {} as Record<string, string>,
    )
  }
}
