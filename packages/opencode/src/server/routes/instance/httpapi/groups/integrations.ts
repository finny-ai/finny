import { RobinhoodIntegration } from "@/integration/robinhood"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const IntegrationPaths = {
  robinhood: "/global/integrations/robinhood",
  robinhoodInstall: "/global/integrations/robinhood/install",
  robinhoodVerify: "/global/integrations/robinhood/verify",
} as const

export const IntegrationsApi = HttpApi.make("integrations").add(
  HttpApiGroup.make("integrations")
    .add(
      HttpApiEndpoint.get("robinhoodStatus", IntegrationPaths.robinhood, {
        success: described(RobinhoodIntegration.Status, "Robinhood rhx integration status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "integrations.robinhood.status",
          summary: "Get Robinhood integration status",
          description: "Passively inspect the managed rhx installation and local authentication state.",
        }),
      ),
      HttpApiEndpoint.post("robinhoodInstall", IntegrationPaths.robinhoodInstall, {
        payload: [HttpApiSchema.NoContent, RobinhoodIntegration.ConfigureInput],
        success: described(RobinhoodIntegration.Status, "Robinhood rhx installation status"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "integrations.robinhood.install",
          summary: "Install or attach rhx",
          description: "Install pinned rhx 0.4.8 on demand or attach a manual executable path.",
        }),
      ),
      HttpApiEndpoint.post("robinhoodVerify", IntegrationPaths.robinhoodVerify, {
        payload: [HttpApiSchema.NoContent, RobinhoodIntegration.ConfigureInput],
        success: described(RobinhoodIntegration.Status, "Robinhood rhx verification status"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "integrations.robinhood.verify",
          summary: "Verify Robinhood authentication",
          description: "Actively verify the configured rhx profile without accepting credentials or MFA input.",
        }),
      ),
      HttpApiEndpoint.delete("robinhoodDetach", IntegrationPaths.robinhood, {
        success: described(RobinhoodIntegration.Status, "Detached Robinhood rhx integration status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "integrations.robinhood.detach",
          summary: "Detach Robinhood integration",
          description: "Remove connector-owned Finny metadata while leaving rhx credentials and npm cache untouched.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "integrations", description: "Global managed integrations." })),
)
