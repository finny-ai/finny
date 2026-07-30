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

const ArtifactPayload = Schema.Struct({
  sessionId: Schema.String,
  algorithmId: Schema.String,
  experimentPlanId: Schema.String,
})

const ArtifactResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  algorithmId: Schema.String,
  algorithmVersion: Schema.Number,
  algorithmName: Schema.String,
  language: Schema.String,
  code: Schema.String,
  config: Schema.String,
  codeHash: Schema.String,
  configHash: Schema.String,
  experimentPlanId: Schema.String,
  experimentPlanHash: Schema.String,
  qualificationPolicyId: Schema.String,
  qualificationPolicyHash: Schema.String,
  datasetEvidenceId: Schema.String,
  datasetHash: Schema.String,
  datasetManifestHash: Schema.String,
  holdoutEventHash: Schema.String,
  confirmatoryAttemptId: Schema.String,
  confirmatoryResult: Schema.Record(Schema.String, Schema.Unknown),
  confirmatoryResultHash: Schema.String,
  completedPhases: Schema.Tuple([
    Schema.Literal("exploratory"),
    Schema.Literal("validation"),
    Schema.Literal("confirmatory"),
  ]),
  qualificationDecision: Schema.Record(Schema.String, Schema.Unknown),
  qualificationDecisionHash: Schema.String,
  artifactEvidenceHash: Schema.String,
})

export class FundQualificationImportApiError extends Schema.ErrorClass<FundQualificationImportApiError>(
  "FundQualificationImportError",
)(
  {
    name: Schema.Literal("FundQualificationImportError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class FundQualificationArtifactApiError extends Schema.ErrorClass<FundQualificationArtifactApiError>(
  "FundQualificationArtifactError",
)(
  {
    name: Schema.Literal("FundQualificationArtifactError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const FundQualificationApi = HttpApi.make("fundQualification").add(
  HttpApiGroup.make("fundQualification")
    .add(
      HttpApiEndpoint.post("datasetImport", "/fund/qualification/dataset", {
        query: WorkspaceRoutingQuery,
        payload: Payload,
        success: described(Result, "Imported authoritative qualification dataset"),
        error: FundQualificationImportApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fund.qualification.dataset.import",
          summary: "Import a controller-owned qualification dataset",
          description:
            "Hash-verifies a bounded OHLCV CSV and creates DatasetEvidenceV2 inside the exact Finny session workspace.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("artifactExport", "/fund/qualification/artifact", {
        query: WorkspaceRoutingQuery,
        payload: ArtifactPayload,
        success: described(ArtifactResult, "Exact qualified artifact evidence"),
        error: FundQualificationArtifactApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fund.qualification.artifact.export",
          summary: "Export exact qualified artifact evidence",
          description:
            "Revalidates and exports the exact saved code/config plus immutable plan, dataset, holdout, policy, and durable confirmatory evidence.",
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
