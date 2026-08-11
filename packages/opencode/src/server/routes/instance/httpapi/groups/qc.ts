import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const QcCredentialInput = Schema.Struct({
  userId: Schema.String,
  apiToken: Schema.String,
})

export const QcStatusResponse = Schema.Struct({
  connected: Schema.Boolean,
  fixture: Schema.optional(Schema.Boolean),
  mode: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["fixture", "cloud"]),
      configured: Schema.Literals(["fixture", "cloud"]),
      source: Schema.Literals(["env", "setting", "default"]),
    }),
  ),
  userId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const QcConnectResponse = Schema.Struct({
  connected: Schema.Literal(true),
  userId: Schema.String,
  name: Schema.String,
})

export const QcModeResponse = Schema.Struct({
  mode: Schema.Literals(["fixture", "cloud"]),
  configured: Schema.Literals(["fixture", "cloud"]),
  source: Schema.Literals(["env", "setting", "default"]),
})

export const QcModeRequest = Schema.Struct({
  mode: Schema.Literals(["fixture", "cloud"]),
})

export const QcProjectSummary = Schema.Struct({
  projectId: Schema.Number,
  name: Schema.String,
  language: Schema.Literals(["python", "csharp"]),
  modified: Schema.String,
})

export const QcLinkRequest = Schema.Struct({
  algorithmId: Schema.String,
  projectId: Schema.Number,
  mode: Schema.optional(Schema.Literals(["reuse_local", "import_remote"])),
})

export const QcImportRequest = Schema.Struct({
  projectId: Schema.Number,
  algorithmName: Schema.optional(Schema.String),
})

export const QcResolveDriftRequest = Schema.Struct({
  direction: Schema.Literals(["import_qc", "push_finny"]),
})

export const QcDeployRequest = Schema.Struct({
  algorithmId: Schema.String,
  runId: Schema.String,
  nodeId: Schema.optional(Schema.String),
  capital: Schema.optional(Schema.Number),
})

export const QcCompositeBacktestRequest = Schema.Struct({
  algorithmId: Schema.String,
  interval: Schema.optional(Schema.String),
  capital: Schema.optional(Schema.Number),
  startDate: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
})

export const QcSyncStateResponse = Schema.Struct({
  linked: Schema.Boolean,
  state: Schema.optional(
    Schema.Literals(["in_sync", "qc_changed", "finny_changed", "both_changed"]),
  ),
  projectId: Schema.optional(Schema.Number),
  projectName: Schema.optional(Schema.String),
  language: Schema.optional(Schema.Literals(["python", "csharp"])),
  drift: Schema.Array(Schema.String),
  action: Schema.optional(Schema.Literals(["in_sync", "import_qc", "push_finny", "blocked"])),
})

export const QcApi = HttpApi.make("qc").add(
  HttpApiGroup.make("qc")
    .add(
      HttpApiEndpoint.post("connect", "/qc/credentials", {
        payload: QcCredentialInput,
        success: QcConnectResponse,
        error: HttpApiError.BadRequest,
      }),
    )
    .add(
      HttpApiEndpoint.get("status", "/qc/status", {
        success: QcStatusResponse,
      }),
    )
    .add(
      HttpApiEndpoint.get("mode", "/qc/mode", {
        success: QcModeResponse,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.mode",
          summary: "Read the QC track mode",
          description: "Local fixture vs QuantConnect Cloud, and where the effective mode came from.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("setMode", "/qc/mode", {
        payload: QcModeRequest,
        success: QcModeResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.mode.set",
          summary: "Switch the QC track mode",
          description: "Persists the mode; env-var overrides still win for test/harness runs.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("disconnect", "/qc/credentials", {
        success: QcStatusResponse,
      }),
    )
    .add(
      HttpApiEndpoint.get("projects", "/qc/projects", {
        success: Schema.Array(QcProjectSummary),
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.projects",
          summary: "List QuantConnect projects",
          description: "List QC projects owned by the connected account that can be linked.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("syncState", "/qc/link/:algorithmId", {
        params: { algorithmId: Schema.String },
        success: QcSyncStateResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.link.state",
          summary: "Read QC link and sync state",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("link", "/qc/link", {
        payload: QcLinkRequest,
        success: QcSyncStateResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.link",
          summary: "Link an algorithm to a QuantConnect project",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("importProject", "/qc/import", {
        payload: QcImportRequest,
        success: Schema.Struct({
          algorithmId: Schema.String,
          algorithmName: Schema.String,
          version: Schema.Number,
          projectId: Schema.Number,
        }),
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.import",
          summary: "Import a QuantConnect project as a linked Finny algorithm",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("refreshSync", "/qc/link/:algorithmId/sync", {
        params: { algorithmId: Schema.String },
        success: QcSyncStateResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.link.sync",
          summary: "Refresh QC project sync state",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("resolveDrift", "/qc/link/:algorithmId/resolve", {
        params: { algorithmId: Schema.String },
        payload: QcResolveDriftRequest,
        success: QcSyncStateResponse,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.link.resolve",
          summary: "Resolve QC source drift in one explicit direction",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("unlink", "/qc/link/:algorithmId", {
        params: { algorithmId: Schema.String },
        success: Schema.Boolean,
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.link.delete",
          summary: "Unlink an algorithm from its QuantConnect project",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("deployments", "/qc/deployments", {
        success: Schema.Array(
          Schema.Struct({
            deploymentId: Schema.String,
            algorithmId: Schema.String,
            algorithmName: Schema.String,
            projectId: Schema.Union([Schema.Number, Schema.String]),
            status: Schema.Literals(["starting", "running", "stopped", "error"]),
            ownership: Schema.Literals(["managed", "external"]),
            qcStatus: Schema.optional(Schema.String),
            liveUrl: Schema.optional(Schema.String),
            lastSyncedAt: Schema.optional(Schema.Number),
            error: Schema.optional(Schema.String),
          }),
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.deployments",
          summary: "List QC deployments",
          description: "Managed and discovered QuantConnect Paper deployments.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("deploy", "/qc/deploy", {
        payload: QcDeployRequest,
        success: Schema.Struct({
          ok: Schema.Boolean,
          deploymentId: Schema.optional(Schema.String),
          status: Schema.optional(Schema.Literals(["starting", "running", "stopped", "error"])),
          projectId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
          error: Schema.optional(Schema.String),
          idempotent: Schema.optional(Schema.Boolean),
        }),
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.deploy",
          summary: "Deploy an approved run to QC Paper",
          description: "Requires an existing paper approval for the exact run; idempotent by run identity + project.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("stopDeployment", "/qc/deployments/:deploymentId/stop", {
        params: { deploymentId: Schema.String },
        success: Schema.Struct({
          ok: Schema.Boolean,
          status: Schema.optional(Schema.Literals(["starting", "running", "stopped", "error"])),
          error: Schema.optional(Schema.String),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.deployments.stop",
          summary: "Stop a QC deployment",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("liquidateDeployment", "/qc/deployments/:deploymentId/liquidate", {
        params: { deploymentId: Schema.String },
        success: Schema.Struct({
          ok: Schema.Boolean,
          status: Schema.optional(Schema.Literals(["starting", "running", "stopped", "error"])),
          error: Schema.optional(Schema.String),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.deployments.liquidate",
          summary: "Liquidate positions and stop a QC deployment",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("compositeBacktest", "/qc/backtest", {
        payload: QcCompositeBacktestRequest,
        success: Schema.Struct({
          ok: Schema.Boolean,
          error: Schema.optional(Schema.String),
          projectId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
          backtestId: Schema.optional(Schema.String),
          backtestUrl: Schema.optional(Schema.String),
          compositeVerdict: Schema.optional(
            Schema.Literals(["recommended_for_paper", "candidate", "failed"]),
          ),
          canonical: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          cloudGates: Schema.optional(
            Schema.Struct({
              passed: Schema.Boolean,
              checks: Schema.Array(
                Schema.Struct({
                  name: Schema.String,
                  passed: Schema.Boolean,
                  detail: Schema.String,
                }),
              ),
            }),
          ),
        }),
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "qc.backtest",
          summary: "Run the QC Cloud + Crucible composite backtest",
          description: "Long-running daemon-side composite evaluation for a linked algorithm.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "QuantConnect",
        description: "Verify, store, and manage QuantConnect API credentials for the QC Cloud track.",
      }),
    ),
)
