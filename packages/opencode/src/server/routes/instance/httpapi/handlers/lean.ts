import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { LeanAdapter } from "@/backtest/lean/adapter"
import { leanConfigStatus, setLeanEnabled, LEAN_ADAPTER_CERT_VALUE } from "@/backtest/lean/lean-config"
import {
  buildLeanEngineImage,
  leanEngineImageStatus,
  pullPinnedLeanImage,
  updateLeanEngineToLatest,
} from "@/backtest/lean/engine-image"
import type { InstanceHttpApiType } from "../api"

export function leanHandlers(api: InstanceHttpApiType) {
  const toResponse = async (status: Awaited<ReturnType<typeof leanConfigStatus>>) => ({
    enabled: status.enabled,
    effective: status.effective,
    source: status.source,
    certified: status.adapterCert === LEAN_ADAPTER_CERT_VALUE,
    readiness: new LeanAdapter().probeReady(),
    engineImage: await leanEngineImageStatus(),
    ...(status.adapterCert ? { adapterCert: status.adapterCert } : {}),
  })
  const action = (run: () => Promise<Awaited<ReturnType<typeof pullPinnedLeanImage>>>) =>
    Effect.tryPromise({
      try: run,
      catch: () => new HttpApiError.BadRequest({}),
    })
  return HttpApiBuilder.group(api, "lean", (handlers) =>
    Effect.succeed(
      handlers
        .handle("status", () =>
          Effect.promise(async () => toResponse(await leanConfigStatus())),
        )
        .handle("pullEngineImage", () => action(() => pullPinnedLeanImage()))
        .handle("buildEngineImage", () => action(() => buildLeanEngineImage()))
        .handle("updateEngineImage", () => action(() => updateLeanEngineToLatest()))
        .handle("setEnabled", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              await setLeanEnabled(payload.enabled)
              return toResponse(await leanConfigStatus())
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        ),
    ),
  )
}
