import { importQualificationDatasetV1, QualificationDatasetImportError } from "@/fund/qualification-dataset-import"
import { exportQualificationArtifactV1, QualificationArtifactExportError } from "@/fund/qualification-artifact-export"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InstanceHttpApiType } from "../api"
import { FundQualificationArtifactApiError, FundQualificationImportApiError } from "../groups/fund-qualification-api"

export function fundQualificationHandlers(api: InstanceHttpApiType) {
  return HttpApiBuilder.group(api, "fundQualification", (handlers) =>
    handlers
      .handle("datasetImport", ({ payload }) =>
        Effect.tryPromise({
          try: () => importQualificationDatasetV1(payload),
          catch: (error) =>
            error instanceof QualificationDatasetImportError
              ? new FundQualificationImportApiError({
                  name: "FundQualificationImportError",
                  data: { message: error.message },
                })
              : error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof FundQualificationImportApiError ? Effect.fail(error) : Effect.die(error),
          ),
        ),
      )
      .handle("artifactExport", ({ payload }) =>
        Effect.tryPromise({
          try: () => exportQualificationArtifactV1(payload),
          catch: (error) =>
            error instanceof QualificationArtifactExportError
              ? new FundQualificationArtifactApiError({
                  name: "FundQualificationArtifactError",
                  data: { message: error.message },
                })
              : error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof FundQualificationArtifactApiError ? Effect.fail(error) : Effect.die(error),
          ),
        ),
      ),
  )
}
