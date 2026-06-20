import { Schema } from "effect"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/services"
import { WorkspaceRoutingMiddleware } from "../middleware/services"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing-query"
import { described } from "./metadata"
import { DATA_AGENT_INSTRUCTIONS_PATH } from "./config-constants"

const root = "/config"

export const DataAgentInstructions = Schema.Struct({
  path: Schema.Literal(DATA_AGENT_INSTRUCTIONS_PATH),
  absolute_path: Schema.String,
  content: Schema.String,
  exists: Schema.Boolean,
})

export const DataAgentInstructionsInput = Schema.Struct({
  content: Schema.String,
})

export const FinnyHomeArtifacts = Schema.Struct({
  algos: Schema.String,
  sessionWorkspaces: Schema.String,
  pythonEnv: Schema.String,
  algorithms: Schema.String,
})

export const FinnyHomeInfo = Schema.Struct({
  path: Schema.String,
  source: Schema.Union([Schema.Literal("env"), Schema.Literal("prefs"), Schema.Literal("default")]),
  configurable: Schema.Boolean,
  defaultPath: Schema.String,
  prefsPath: Schema.String,
  artifacts: FinnyHomeArtifacts,
})

export const FinnyHomeInput = Schema.Union([
  Schema.Struct({ path: Schema.String }),
  Schema.Struct({ path: Schema.Null }),
])

export class FinnyHomeApiError extends Schema.ErrorClass<FinnyHomeApiError>("FinnyHomeError")(
  {
    name: Schema.Literal("FinnyHomeError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("finnyHome", `${root}/finny-home`, {
          query: WorkspaceRoutingQuery,
          success: described(FinnyHomeInfo, "Finny Home storage settings"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.finnyHome.get",
            summary: "Get Finny Home",
            description: "Resolve the effective Finny Home storage root and artifact subpaths.",
          }),
        ),
        HttpApiEndpoint.patch("updateFinnyHome", `${root}/finny-home`, {
          query: WorkspaceRoutingQuery,
          payload: FinnyHomeInput,
          success: described(FinnyHomeInfo, "Updated Finny Home storage settings"),
          error: FinnyHomeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.finnyHome.update",
            summary: "Update Finny Home",
            description: "Save or clear the user-selected Finny Home storage root.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
        HttpApiEndpoint.get("dataAgentInstructions", `${root}/data-agent-instructions`, {
          query: WorkspaceRoutingQuery,
          success: described(DataAgentInstructions, "Data Agent instructions file"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.dataAgentInstructions.get",
            summary: "Get Data Agent instructions",
            description: "Read the repo-level data-agent/instructions.md source cookbook for the current instance.",
          }),
        ),
        HttpApiEndpoint.put("updateDataAgentInstructions", `${root}/data-agent-instructions`, {
          query: WorkspaceRoutingQuery,
          payload: DataAgentInstructionsInput,
          success: described(DataAgentInstructions, "Updated Data Agent instructions file"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.dataAgentInstructions.update",
            summary: "Update Data Agent instructions",
            description: "Write the repo-level data-agent/instructions.md source cookbook for the current instance.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
