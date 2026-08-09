import {
  AgentControlV1,
  CampaignControlV1,
  CommandReceiptV1,
  ControlAbortV1,
  ControlCreateSessionV1,
  ControlPromptV1,
  ControlSnapshotV1,
  CrucibleEventControlV1,
  CrucibleWorkflowControlV1,
} from "@/control/control-contracts"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware, WorkspaceRoutingMiddleware } from "../middleware/services"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing-query"
import { described } from "./metadata"

export const ControlAgentsQueryV1 = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  state: Schema.optional(Schema.Literals(["busy", "idle", "error", "blocked"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
}).annotate({ identifier: "ControlAgentsQueryV1" })

export const ControlEventsQueryV1 = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  afterSeq: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "ControlEventsQueryV1" })

export class ControlCommandNotFoundV1 extends Schema.ErrorClass<ControlCommandNotFoundV1>("ControlCommandNotFoundV1")(
  {
    operationID: Schema.String,
    accepted: Schema.Literal(false),
    sessionID: Schema.optional(Schema.String),
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

const group = HttpApiGroup.make("controlV1")
  .add(
    HttpApiEndpoint.get("overview", "/control/v1/overview", {
      query: WorkspaceRoutingQuery,
      success: described(ControlSnapshotV1, "Unified Finny control snapshot"),
    }),
    HttpApiEndpoint.get("agents", "/control/v1/agents", {
      query: ControlAgentsQueryV1,
      success: described(Schema.Array(AgentControlV1), "Root agent sessions"),
    }),
    HttpApiEndpoint.get("crucible", "/control/v1/crucible", {
      query: WorkspaceRoutingQuery,
      success: described(Schema.Array(CrucibleWorkflowControlV1), "Recent Crucible workflows"),
    }),
    HttpApiEndpoint.get("crucibleEvents", "/control/v1/crucible/:workflowID/events", {
      params: { workflowID: Schema.String },
      query: ControlEventsQueryV1,
      success: described(Schema.Array(CrucibleEventControlV1), "Crucible workflow events"),
    }),
    HttpApiEndpoint.get("campaigns", "/control/v1/campaigns", {
      query: WorkspaceRoutingQuery,
      success: described(Schema.Array(CampaignControlV1), "Campaign summaries"),
    }),
    HttpApiEndpoint.post("createSession", "/control/v1/sessions", {
      query: WorkspaceRoutingQuery,
      payload: ControlCreateSessionV1,
      success: described(CommandReceiptV1, "Session command receipt"),
    }),
    HttpApiEndpoint.post("prompt", "/control/v1/prompts", {
      query: WorkspaceRoutingQuery,
      payload: ControlPromptV1,
      success: described(CommandReceiptV1, "Prompt command receipt"),
      error: ControlCommandNotFoundV1,
    }),
    HttpApiEndpoint.post("abort", "/control/v1/abort", {
      query: WorkspaceRoutingQuery,
      payload: ControlAbortV1,
      success: described(CommandReceiptV1, "Abort command receipt"),
      error: ControlCommandNotFoundV1,
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)
  .annotateMerge(
    OpenApi.annotations({
      title: "Finny control v1",
      description: "Read and command surface for the Finny control panel.",
    }),
  )

export const ControlV1Api = HttpApi.make("control-v1").add(group)
