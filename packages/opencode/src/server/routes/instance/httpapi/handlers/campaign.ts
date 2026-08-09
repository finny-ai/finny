import { CampaignController } from "@/control-plane/campaign"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiCampaignError } from "../groups/campaign"

const mapError = Effect.mapError(
  (error: CampaignController.Error) =>
    new ApiCampaignError({ name: "CampaignError", data: { message: error.message } }),
)

export const campaignHandlers = HttpApiBuilder.group(InstanceHttpApi, "campaign", (handlers) =>
  Effect.gen(function* () {
    const campaign = yield* CampaignController.Service
    return handlers
      .handle("create", ({ payload }) => campaign.create(payload).pipe(mapError))
      .handle("get", ({ params }) => campaign.get(params.campaignID).pipe(mapError))
      .handle("start", ({ params, payload }) =>
        campaign.start(params.campaignID, payload.operationID, params.candidateID).pipe(mapError),
      )
      .handle("continue", ({ params, payload }) => campaign.continueSession(params.campaignID, payload).pipe(mapError))
      .handle("abort", ({ params, payload }) =>
        campaign.abort(params.campaignID, payload.operationID, payload.candidateID).pipe(mapError),
      )
      .handle("recordArtifact", ({ params, payload }) =>
        campaign.recordArtifact(params.campaignID, payload).pipe(mapError),
      )
      .handle("events", ({ params, query }) => campaign.events(params.campaignID, query.after).pipe(mapError))
      .handle("wait", ({ params, query }) =>
        campaign.wait(params.campaignID, query.after, query.timeoutMs).pipe(mapError),
      )
      .handle("compare", ({ params }) => campaign.compare(params.campaignID).pipe(mapError))
      .handle("advance", ({ params, payload }) => campaign.advance(params.campaignID, payload).pipe(mapError))
  }),
)
