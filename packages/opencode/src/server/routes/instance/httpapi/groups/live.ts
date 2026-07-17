import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, LiveRunNotFoundError, LiveRunStartError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware, WorkspaceRoutingMiddleware } from "../middleware/services"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing-query"
import { described } from "./metadata"

const root = "/live"

// Effect-Schema mirrors of the LiveRunner namespace TS interfaces. These must
// stay in sync with packages/opencode/src/live/runner.ts.
const BrokerKind = Schema.Literals(["alpaca", "binance", "ibkr"])
const BrokerMode = Schema.Literals(["paper", "testnet", "live"])
const RunStatus = Schema.Literals(["starting", "running", "stopped", "error"])

const OrderEvent = Schema.Struct({
  order_id: Schema.String,
  symbol: Schema.String,
  side: Schema.String,
  qty: Schema.Number,
  price: Schema.Number,
  status: Schema.String,
  ts: Schema.String,
})

const LogEntry = Schema.Struct({
  ts: Schema.Number,
  level: Schema.Literals(["info", "warn", "error"]),
  message: Schema.String,
})

const BarUpdate = Schema.Struct({
  timestamp: Schema.String,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
  volume: Schema.Number,
})

export const Run = Schema.Struct({
  id: Schema.String,
  algorithmId: Schema.String,
  algorithmName: Schema.String,
  backtestRunId: Schema.String,
  symbol: Schema.String,
  interval: Schema.String,
  brokerKind: BrokerKind,
  accountProviderID: Schema.String,
  accountLabel: Schema.optional(Schema.String),
  mode: Schema.optional(BrokerMode),
  directory: Schema.optional(Schema.String),
  status: RunStatus,
  startedAt: Schema.Number,
  stoppedAt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  lastBar: Schema.optional(BarUpdate),
  equity: Schema.optional(Schema.Number),
  cash: Schema.optional(Schema.Number),
  positions: Schema.Record(Schema.String, Schema.Number),
  orders: Schema.Array(OrderEvent),
  logs: Schema.Array(LogEntry),
}).annotate({ identifier: "LiveRun" })

// Mirror of Algorithm.Info (zod) — see packages/opencode/src/algorithm/index.ts.
const AlgorithmInfo = Schema.Struct({
  algorithmId: Schema.String,
  userId: Schema.String,
  name: Schema.String,
  code: Schema.String,
  language: Schema.String,
  version: Schema.Number,
  status: Schema.String,
  description: Schema.optional(Schema.String),
  config: Schema.optional(Schema.String),
  backtestCode: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.String),
  brokerKind: Schema.optional(BrokerKind),
  targetBrokerage: Schema.optional(BrokerKind),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "LiveAlgorithmInfo" })

export const StartPayload = Schema.Struct({
  algorithm: AlgorithmInfo,
  runId: Schema.String,
  symbol: Schema.String,
  interval: Schema.String,
  accountProviderID: Schema.String,
  brokerKind: Schema.optional(BrokerKind),
}).annotate({ identifier: "LiveStartPayload" })

export const LiveApi = HttpApi.make("live")
  .add(
    HttpApiGroup.make("live")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Run), "Live runs for the current project"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "live.list",
            summary: "List live runs",
            description: "List the live/paper trading runs owned by the daemon for the current project directory.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Run, "A live run"),
          error: [LiveRunNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "live.get",
            summary: "Get a live run",
            description: "Get a single live run by id.",
          }),
        ),
        HttpApiEndpoint.post("start", `${root}/start`, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(Run, "The starting run snapshot"),
          error: [LiveRunStartError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "live.start",
            summary: "Start a live run",
            description: "Start a live/paper trading run. Returns immediately with a 'starting' snapshot.",
          }),
        ),
        HttpApiEndpoint.post("stop", `${root}/:id/stop`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether the run was stopped"),
          error: [LiveRunNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "live.stop",
            summary: "Stop a live run",
            description: "Stop a running live/paper run.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether the run was removed"),
          error: [LiveRunNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "live.remove",
            summary: "Remove a live run",
            description: "Remove a stopped run from the daemon's registry.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "live",
          description: "Live/paper trading runs hosted by the Finny daemon.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode live trading HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for live/paper trading runs.",
    }),
  )
