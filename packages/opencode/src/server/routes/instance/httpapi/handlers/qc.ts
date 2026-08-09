import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  connectQcCredentials,
  disconnectQcCredentials,
  qcConnectionState,
} from "@/integration/quantconnect"
import type { InstanceHttpApiType } from "../api"

export function qcHandlers(api: InstanceHttpApiType) {
  return HttpApiBuilder.group(api, "qc", (handlers) =>
    Effect.succeed(
      handlers
        .handle("connect", ({ payload }) =>
          Effect.tryPromise({
            try: () => connectQcCredentials(payload),
            catch: () => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("status", () => Effect.promise(() => qcConnectionState()))
        .handle("disconnect", () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => disconnectQcCredentials())
            return yield* Effect.promise(() => qcConnectionState())
          }),
        ),
    ),
  )
}
