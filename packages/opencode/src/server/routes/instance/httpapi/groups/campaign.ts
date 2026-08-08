import * as CampaignContract from "@/control-plane/campaign-contract"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InstanceContextMiddleware, WorkspaceRoutingMiddleware } from "../middleware/services"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing-query"
import { described } from "./metadata"

const root = "/experimental/campaign"
const CampaignID = Schema.String
const OperationPayload = Schema.Struct({ operationID: Schema.String })
const AbortPayload = Schema.Struct({ operationID: Schema.String, candidateID: Schema.optional(Schema.String) })

const Candidate = Schema.Struct({
  ...CampaignContract.CandidateInput.fields,
  sessionID: Schema.optional(Schema.String),
  status: Schema.Literals(["queued", "running", "idle", "aborted", "failed"]),
  turns: Schema.Number,
  manifestIDs: Schema.Array(Schema.String),
  lastOperationID: Schema.optional(Schema.String),
})
const Event = Schema.Struct({
  cursor: Schema.Number,
  time: Schema.Number,
  type: Schema.String,
  candidateID: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export const CampaignInfo = Schema.Struct({
  id: Schema.String,
  goal: Schema.String,
  agent: Schema.String,
  status: Schema.Literals(["active", "stopped", "aborted"]),
  reason: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  budget: CampaignContract.Budget,
  stop: CampaignContract.StopRules,
  rounds: Schema.Number,
  candidates: Schema.Array(Candidate),
  operations: Schema.Record(
    Schema.String,
    Schema.Struct({ kind: Schema.String, requestHash: Schema.String, result: Schema.optional(Schema.Unknown) }),
  ),
  events: Schema.Array(Event),
  nextCursor: Schema.Number,
}).annotate({ identifier: "Campaign" })

const RankedCandidate = Schema.Struct({
  rank: Schema.Number,
  candidateID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  manifestID: Schema.String,
  algorithmID: Schema.String,
  algorithmName: Schema.String,
  assumptionsKey: Schema.String,
  sharpeRatio: Schema.Finite,
  maxDrawdown: Schema.Finite,
  totalReturn: Schema.Finite,
  eligibilityStatus: Schema.optional(Schema.String),
  artifactRefs: Schema.Array(Schema.String),
})
const Comparison = Schema.Struct({
  campaignID: Schema.String,
  assumptionsKey: Schema.NullOr(Schema.String),
  comparable: Schema.Boolean,
  excluded: Schema.Array(
    Schema.Struct({ candidateID: Schema.String, manifestID: Schema.String, reason: Schema.String }),
  ),
  ranking: Schema.Array(RankedCandidate),
  promotion: Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
})

export class ApiCampaignError extends Schema.ErrorClass<ApiCampaignError>("CampaignError")(
  { name: Schema.Literal("CampaignError"), data: Schema.Struct({ message: Schema.String }) },
  { httpApiStatus: 409 },
) {}

const endpoint = HttpApiGroup.make("campaign")
  .add(
    HttpApiEndpoint.post("create", root, {
      query: WorkspaceRoutingQuery,
      payload: CampaignContract.CreateInput,
      success: described(CampaignInfo, "Campaign created or recovered"),
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.get("get", `${root}/:campaignID`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      success: described(CampaignInfo, "Campaign state"),
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.post("start", `${root}/:campaignID/candidate/:candidateID/start`, {
      params: { campaignID: CampaignID, candidateID: Schema.String },
      query: WorkspaceRoutingQuery,
      payload: OperationPayload,
      success: CampaignInfo,
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.post("continue", `${root}/:campaignID/continue`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      payload: CampaignContract.ContinueInput,
      success: CampaignInfo,
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.post("abort", `${root}/:campaignID/abort`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      payload: AbortPayload,
      success: CampaignInfo,
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.post("recordArtifact", `${root}/:campaignID/artifact`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      payload: CampaignContract.ArtifactInput,
      success: CampaignInfo,
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.get("events", `${root}/:campaignID/event`, {
      params: { campaignID: CampaignID },
      query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, ...CampaignContract.EventQuery.fields }),
      success: Schema.Array(Event),
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.get("wait", `${root}/:campaignID/wait`, {
      params: { campaignID: CampaignID },
      query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, ...CampaignContract.WaitQuery.fields }),
      success: Schema.Array(Event),
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.get("compare", `${root}/:campaignID/comparison`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      success: Comparison,
      error: ApiCampaignError,
    }),
    HttpApiEndpoint.post("advance", `${root}/:campaignID/advance`, {
      params: { campaignID: CampaignID },
      query: WorkspaceRoutingQuery,
      payload: CampaignContract.AdvanceInput,
      success: CampaignInfo,
      error: ApiCampaignError,
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "campaign",
      description: "Durable, model-neutral parent-harness campaign orchestration.",
    }),
  )

export const CampaignApi = HttpApi.make("campaign").add(endpoint)
