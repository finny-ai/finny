import { importQualificationDatasetV1 } from "@/fund/qualification-dataset-import"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InstanceHttpApiType } from "../api"

export function fundQualificationHandlers(api: InstanceHttpApiType) {
  return HttpApiBuilder.group(api, "fundQualification", (handlers) =>
    handlers.handle("datasetImport", ({ payload }) =>
      Effect.tryPromise({
        try: () => importQualificationDatasetV1(payload),
        catch: (error) => error,
      }).pipe(Effect.orDie),
    ),
  )
}
