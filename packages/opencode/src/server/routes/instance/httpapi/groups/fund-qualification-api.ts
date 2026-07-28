import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware, WorkspaceRoutingMiddleware } from "../middleware/services"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing-query"
import { described } from "./metadata"

const Payload = Schema.Struct({
  sessionId: Schema.String,
  algorithmName: Schema.String,
  symbol: Schema.String,
  assetClass: Schema.Literals(["equity", "crypto"]),
  interval: Schema.String,
  requestedStart: Schema.String,
  requestedEnd: Schema.String,
  csvBase64: Schema.String,
  csvSha256: Schema.String,
  providerId: Schema.Literals(["alpaca", "binance"]),
  providerFeed: Schema.String,
  providerVenue: Schema.String,
  providerSymbol: Schema.String,
  priceBasis: Schema.Literals(["raw", "adjusted"]),
  splitTreatment: Schema.String,
  dividendTreatment: Schema.String,
  corporateActionStatus: Schema.Literals(["resolved", "not_applicable"]),
})

const Result = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  workspaceSlug: Schema.String,
  requestId: Schema.String,
  requestVersion: Schema.Number,
  requestContentHash: Schema.String,
  evidenceId: Schema.String,
  qualification: Schema.String,
  csvSha256: Schema.String,
  manifestSha256: Schema.String,
  outputPath: Schema.String,
})

export const FundQualificationApi = HttpApi.make("fundQualification")
  .add(
    HttpApiGroup.make("fundQualification")
      .add(
        HttpApiEndpoint.post("datasetImport", "/fund/qualification/dataset", {
          query: WorkspaceRoutingQuery,
          payload: Payload,
          success: described(Result, "Imported authoritative qualification dataset"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "fund.qualification.dataset.import",
            summary: "Import a controller-owned qualification dataset",
            description:
              "Hash-verifies a bounded OHLCV CSV and creates DatasetEvidenceV2 inside the exact Finny session workspace.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "fund qualification",
          description: "Private controller bridge for strict strategy qualification.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
