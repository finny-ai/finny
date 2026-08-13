import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import {
  connectQcCredentials,
  disconnectQcCredentials,
  qcConnectionState,
  resolveQcMode,
} from "@/integration/quantconnect"
import { setConfiguredQcMode } from "@/integration/qc-store"
import {
  runQcCloudBacktest,
  deployQcPaper,
  deployQcLive,
  stopQcPaper,
  stopQcLive,
  liquidateQcLive,
  listPaperDeployments,
  reconcileQcDeployments,
  listQcProjects,
  availableLiveNodes,
  compileQcProject,
  pushStrategyToQc,
} from "@/integration/qc-cloud"
import {
  attachProject,
  listLinkableProjects,
  refreshLinkSync,
  resolveDrift,
  unlinkProject,
} from "@/integration/qc-sync"
import { getProjectLink } from "@/integration/qc-store"
import * as QcExecution from "@/integration/qc-execution"
import { readApproval, strictRunDir } from "@/backtest/run-integrity"
import { controllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { Database } from "@opencode-ai/core/database/database"
import { Algorithm } from "@/algorithm"

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

export const QcCommand = cmd({
  command: "qc",
  describe: "connect and manage your QuantConnect API credentials",
  builder: (yargs) =>
    yargs
      .command(QcConnectCommand)
      .command(QcStatusCommand)
      .command(QcModeCommand)
      .command(QcDisconnectCommand)
      .command(QcBacktestCommand)
      .command(QcPaperDeployCommand)
      .command(QcPaperListCommand)
      .command(QcPaperStopCommand)
      .command(QcLiveDeployCommand)
      .command(QcLiveListCommand)
      .command(QcLiveStopCommand)
      .command(QcLiveLiquidateCommand)
      .command(QcProjectsCommand)
      .command(QcNodesCommand)
      .command(QcLinkCommand)
      .command(QcUnlinkCommand)
      .command(QcSyncCommand)
      .command(QcResolveDriftCommand)
      .command(QcDeploymentsCommand)
      .command(QcDeployCommand)
      .command(QcStopDeploymentCommand)
      .command(QcLiquidateDeploymentCommand)
      .demandCommand(),
  async handler() {},
})

function backtestWindowArgs(yargs: any) {
  return yargs
    .option("duration", { type: "string", default: "6m", describe: "backtest duration" })
    .option("interval", { type: "string", default: "5min", describe: "bar interval" })
    .option("capital", { type: "string", default: "10000", describe: "starting capital" })
    .option("start-date", { type: "string", describe: "exact start date YYYY-MM-DD" })
    .option("end-date", { type: "string", describe: "exact end date YYYY-MM-DD" })
}

function fixtureOhlcvCsv(): string {
  // Deterministic XNYS 5-minute SPY bars for the no-credentials fixture path.
  const lines = ["timestamp,open,high,low,close,volume"]
  let index = 0
  for (let day = 0; day < 180; day++) {
    const date = new Date(Date.UTC(2026, 0, 9 + day))
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue
    for (let slot = 0; slot < 78; slot++) {
      const timestamp = new Date(date.getTime() + (9 * 3600 + 30 * 60 + slot * 5 * 60) * 1000)
      const center = 510 - index * 0.00035
      const wave = 2.4 * Math.sin(index / 23) + 0.65 * Math.sin(index / 7)
      const open = center + wave
      const close = open + 0.08 * Math.sin(index / 3)
      const high = Math.max(open, close) + 0.12
      const low = Math.min(open, close) - 0.12
      lines.push(
        `${timestamp.toISOString()},${open.toFixed(6)},${high.toFixed(6)},${low.toFixed(6)},${close.toFixed(6)},${1_000_000 + (index % 97) * 1000}`,
      )
      index += 1
    }
  }
  return `${lines.join("\n")}\n`
}

const QcBacktestCommand = effectCmd({
  command: "backtest <algorithm>",
  describe: "run a QuantConnect cloud backtest (fixture mode runs the local pinned LEAN engine)",
  builder: backtestWindowArgs,
  handler: Effect.fn("Cli.qc.backtest")(function* (args: any) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const config = JSON.parse(algorithm.config ?? "{}") as Record<string, any>
    const now = new Date()
    const end = args["end-date"] ?? now.toISOString().slice(0, 10)
    const start =
      args["start-date"] ??
      new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10)
    const csv = fixtureOhlcvCsv()
    const outcome = yield* Effect.promise(() =>
      runQcCloudBacktest({
        algorithm,
        ohlcvCsv: csv,
        interval: args.interval,
        capital: Number(args.capital),
        startDate: start,
        endDate: end,
        walkForwardFolds: 0,
      }),
    )
    print(outcome)
  }),
})

const QcPaperDeployCommand = effectCmd({
  command: "paper-deploy <algorithm>",
  describe: "deploy the strategy to paper execution (fixture mode records a local deployment)",
  builder: (yargs) => yargs.positional("algorithm", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.paper")(function* (args: { algorithm: string }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    print(yield* Effect.promise(() => deployQcPaper({ algorithm })))
  }),
})

const QcPaperListCommand = effectCmd({
  command: "paper-list",
  describe: "list paper deployments from the local ledger",
  handler: Effect.fn("Cli.qc.paper.list")(function* () {
    print(yield* Effect.promise(() => listPaperDeployments()))
  }),
})

const QcPaperStopCommand = effectCmd({
  command: "paper-stop <deployment-id>",
  describe: "stop a paper deployment",
  builder: (yargs) => yargs.positional("deployment-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.paper.stop")(function* (args: { "deployment-id": string }) {
    const outcome = yield* Effect.promise(() => stopQcPaper(args["deployment-id"]))
    if (!outcome) throw new Error(`Deployment not found: ${args["deployment-id"]}`)
    print(outcome)
  }),
})

const QcLiveDeployCommand = effectCmd({
  command: "live-deploy <algorithm>",
  describe: "deploy the strategy to QuantConnect Cloud live/paper execution",
  builder: (yargs) =>
    yargs
      .positional("algorithm", { type: "string", demandOption: true })
      .option("broker", {
        type: "string",
        choices: ["qc-paper", "alpaca", "binance"] as const,
        default: "qc-paper",
        describe: "brokerage module used by the QC live deployment",
      })
      .option("provider", {
        type: "string",
        describe: "stored brokerage account provider id (defaults to the first connected account)",
      })
      .option("node", { type: "string", describe: "explicit QC live node id; defaults to the first free node" })
      .option("capital", { type: "number", default: 10000, describe: "starting cash for the QuantConnect Paper brokerage" })
      .option("data-provider", { type: "string", describe: "QC data provider module id override" }),
  handler: Effect.fn("Cli.qc.liveDeploy")(function* (args: any) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const project = yield* Effect.promise(() => pushStrategyToQc({ algorithm }))
    const compile = yield* Effect.promise(() =>
      compileQcProject({ projectId: project.projectId }),
    )
    if (compile.state !== "BuildSuccess") {
      print({
        ok: false,
        error: `QuantConnect compile failed (${compile.state})`,
        logs: (compile.logs ?? []).slice(-10),
      })
      return
    }
    const nodes = yield* Effect.promise(() => availableLiveNodes(project.projectId))
    const node = args.node ?? nodes.find((candidate) => !candidate.busy)?.id ?? nodes[0]?.id
    if (!node) throw new Error("No live node available for this project; add one in QuantConnect first")
    const outcome = yield* Effect.promise(() =>
      deployQcLive({
        algorithm,
        projectId: project.projectId,
        compileId: compile.compileId,
        nodeId: node,
        brokerKind: (args.broker === "qc-paper" ? "qc_paper" : args.broker) as "qc_paper" | "alpaca" | "binance",
        capital: args.capital,
        brokerProviderID: args.provider,
        dataProviderId: args["data-provider"],
      }),
    )
    print(outcome)
  }),
})

const QcLiveListCommand = effectCmd({
  command: "live-list",
  describe: "list paper/live deployments, reconciling cloud status first",
  handler: Effect.fn("Cli.qc.live.list")(function* () {
    print(yield* Effect.promise(() => reconcileQcDeployments()))
  }),
})

const QcLiveStopCommand = effectCmd({
  command: "live-stop <project-id> <deployment-id>",
  describe: "stop a QuantConnect Cloud live deployment",
  builder: (yargs) =>
    yargs
      .positional("project-id", { type: "string", demandOption: true })
      .positional("deployment-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.live.stop")(function* (args: { "project-id": string; "deployment-id": string }) {
    const outcome = yield* Effect.promise(() =>
      stopQcLive({ projectId: args["project-id"], deploymentId: args["deployment-id"] }),
    )
    if (!outcome) throw new Error(`Deployment not found: ${args["deployment-id"]}`)
    print(outcome)
  }),
})

const QcLiveLiquidateCommand = effectCmd({
  command: "live-liquidate <project-id> <deployment-id>",
  describe: "liquidate all positions and stop a QuantConnect Cloud live deployment",
  builder: (yargs) =>
    yargs
      .positional("project-id", { type: "string", demandOption: true })
      .positional("deployment-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.live.liquidate")(function* (args: { "project-id": string; "deployment-id": string }) {
    const outcome = yield* Effect.promise(() =>
      liquidateQcLive({ projectId: args["project-id"], deploymentId: args["deployment-id"] }),
    )
    if (!outcome) throw new Error(`Deployment not found: ${args["deployment-id"]}`)
    print(outcome)
  }),
})

const QcProjectsCommand = effectCmd({
  command: "projects",
  describe: "list QuantConnect projects owned by the connected account",
  handler: Effect.fn("Cli.qc.projects")(function* () {
    print(yield* Effect.promise(() => listQcProjects()))
  }),
})

const QcNodesCommand = effectCmd({
  command: "nodes <project-id>",
  describe: "list available QuantConnect live nodes for a project",
  builder: (yargs) => yargs.positional("project-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.nodes")(function* (args: { "project-id": string }) {
    print(yield* Effect.promise(() => availableLiveNodes(args["project-id"])))
  }),
})

const QcLinkCommand = effectCmd({
  command: "link <algorithm> <project-id>",
  describe: "link a saved algorithm to an existing QuantConnect project",
  builder: (yargs) =>
    yargs
      .positional("algorithm", { type: "string", demandOption: true })
      .positional("project-id", { type: "number", demandOption: true })
      .option("import-remote", {
        type: "boolean",
        describe: "adopt the QC project source as the algorithm source (default when the local tree is empty)",
      }),
  handler: Effect.fn("Cli.qc.link")(function* (args: { algorithm: string; "project-id": number; "import-remote"?: boolean }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const project = (yield* Effect.promise(() => listLinkableProjects())).find(
      (item) => item.projectId === args["project-id"],
    )
    if (!project) throw new Error(`QuantConnect project ${args["project-id"]} not found or not readable`)
    const result = yield* Effect.promise(() =>
      attachProject({
        algorithm,
        projectId: project.projectId,
        projectName: project.name,
        language: project.language,
        mode: args["import-remote"] ? "import_remote" : undefined,
      }),
    )
    print({ linked: true, projectId: result.link.projectId, state: result.link.sync.state, imported: result.imported })
  }),
})

const QcUnlinkCommand = effectCmd({
  command: "unlink <algorithm>",
  describe: "unlink an algorithm from its QuantConnect project",
  builder: (yargs) => yargs.positional("algorithm", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.unlink")(function* (args: { algorithm: string }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    print({ unlinked: yield* Effect.promise(() => unlinkProject(algorithm.algorithmId)) })
  }),
})

const QcSyncCommand = effectCmd({
  command: "sync <algorithm>",
  describe: "refresh the QuantConnect project sync state for an algorithm",
  builder: (yargs) => yargs.positional("algorithm", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.sync")(function* (args: { algorithm: string }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const decision = yield* Effect.promise(() => refreshLinkSync(algorithm))
    const link = yield* Effect.promise(() => getProjectLink(algorithm.algorithmId))
    print({
      linked: Boolean(link),
      state: link?.sync.state,
      projectId: link?.projectId,
      action: decision.action,
      drift: decision.drift ?? [],
    })
  }),
})

const QcResolveDriftCommand = effectCmd({
  command: "resolve-drift <algorithm>",
  describe: "resolve QC source drift in one explicit direction",
  builder: (yargs) =>
    yargs
      .positional("algorithm", { type: "string", demandOption: true })
      .option("direction", {
        type: "string",
        choices: ["import_qc", "push_finny"] as const,
        demandOption: true,
        describe: "import_qc adopts the QC project source; push_finny overwrites QC with the Finny source",
      }),
  handler: Effect.fn("Cli.qc.resolveDrift")(function* (args: { algorithm: string; direction: "import_qc" | "push_finny" }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const decision = yield* Effect.promise(() => resolveDrift({ algorithm, direction: args.direction }))
    if (!decision.ok) throw new Error(decision.error ?? "drift resolution failed")
    print({ resolved: true, direction: args.direction })
  }),
})

const QcDeploymentsCommand = effectCmd({
  command: "deployments",
  describe: "list QuantConnect Paper deployments (managed + discovered)",
  handler: Effect.fn("Cli.qc.deployments")(function* () {
    yield* Effect.promise(() => QcExecution.rehydrate())
    print(
      QcExecution.list().map((run) => ({
        deploymentId: run.qc.deploymentId,
        algorithmName: run.algorithmName,
        projectId: run.qc.projectId,
        status: run.status,
        ownership: run.qc.ownership,
        qcStatus: run.qc.qcStatus,
        lastSyncedAt: run.qc.lastSyncedAt,
        error: run.error,
      })),
    )
  }),
})

const QcDeployCommand = effectCmd({
  command: "deploy <algorithm>",
  describe: "approve-and-deploy an approved run to QuantConnect Paper",
  builder: (yargs) =>
    yargs
      .positional("algorithm", { type: "string", demandOption: true })
      .option("run-id", { type: "string", demandOption: true, describe: "exact approved strict run id" })
      .option("node", { type: "string", describe: "QC live node id (defaults to first free node)" })
      .option("capital", { type: "number", describe: "starting cash for the QC Paper brokerage" }),
  handler: Effect.fn("Cli.qc.deploy")(function* (args: { algorithm: string; "run-id": string; node?: string; capital?: number }) {
    const algorithm = yield* Effect.promise(() => Algorithm.resolve(args.algorithm))
    if (!algorithm) throw new Error(`Algorithm not found: ${args.algorithm}`)
    const database = yield* Database.Service
    const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.runPromise(Effect.provideService(effect, Database.Service, database))
    const approval = yield* Effect.promise(() =>
      readApproval(strictRunDir(algorithm, args["run-id"]), "paper_eligible"),
    )
    const workflow = approval?.workflowId
      ? yield* Effect.promise(() => runWorkflow(BuildWorkflowStore.get(approval.workflowId)))
      : undefined
    const authority = approval
      ? controllerPaperApproval(workflow, {
          algorithmId: algorithm.algorithmId,
          algorithmVersion: algorithm.version,
          runId: args["run-id"],
          identityHash: approval.identityHash,
        })
      : undefined
    const outcome = yield* Effect.promise(() =>
      QcExecution.startPaperDeployment({
        algorithm,
        runId: args["run-id"],
        authority,
        ...(args.node ? { nodeId: args.node } : {}),
        ...(args.capital ? { capital: args.capital } : {}),
      }),
    )
    print(outcome)
  }),
})

const QcStopDeploymentCommand = effectCmd({
  command: "deployment-stop <deployment-id>",
  describe: "stop a QuantConnect Paper deployment",
  builder: (yargs) => yargs.positional("deployment-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.deploymentStop")(function* (args: { "deployment-id": string }) {
    print(yield* Effect.promise(() => QcExecution.stopDeployment(args["deployment-id"])))
  }),
})

const QcLiquidateDeploymentCommand = effectCmd({
  command: "deployment-liquidate <deployment-id>",
  describe: "liquidate positions and stop a QuantConnect Paper deployment",
  builder: (yargs) => yargs.positional("deployment-id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.qc.deploymentLiquidate")(function* (args: { "deployment-id": string }) {
    print(yield* Effect.promise(() => QcExecution.liquidateDeployment(args["deployment-id"])))
  }),
})

const QcConnectCommand = effectCmd({
  command: "connect",
  describe: "verify and store QuantConnect API credentials (user-id + api-token)",
  builder: (yargs) =>
    yargs
      .option("user-id", {
        type: "string",
        demandOption: true,
        describe: "QuantConnect account user id (Account -> Organizations -> your id)",
      })
      .option("api-token", {
        type: "string",
        demandOption: true,
        describe: "QuantConnect API token (Account -> Security -> API Access)",
      }),
  handler: Effect.fn("Cli.qc.connect")(function* (args) {
    try {
      const verified = yield* Effect.promise(() =>
        connectQcCredentials({ userId: args["user-id"], apiToken: args["api-token"] }),
      )
      print({
        connected: true,
        userId: verified.userId,
        name: verified.name,
        note: "Credentials verified against QuantConnect and stored locally (0600).",
      })
    } catch (error) {
      print({
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        note: "Nothing was stored. Fix the credentials and retry qc connect.",
      })
    }
  }),
})

const QcStatusCommand = effectCmd({
  command: "status",
  describe: "show whether QuantConnect API credentials are connected and valid",
  handler: Effect.fn("Cli.qc.status")(function* () {
    const [state, mode] = yield* Effect.all([
      Effect.promise(() => qcConnectionState()),
      Effect.promise(() => resolveQcMode()),
    ])
    print({ ...state, mode })
  }),
})

const QcModeCommand = effectCmd({
  command: "mode [value]",
  describe: "show or switch the QuantConnect track mode (local fixture vs QuantConnect Cloud)",
  builder: (yargs) =>
    yargs.positional("value", {
      type: "string",
      choices: ["local", "cloud"] as const,
      describe: "local runs the QC control plane against deterministic fixtures; cloud talks to QuantConnect",
    }),
  handler: Effect.fn("Cli.qc.mode")(function* (args: { value?: "local" | "cloud" }) {
    if (args.value) {
      yield* Effect.promise(() => setConfiguredQcMode(args.value === "local" ? "fixture" : "cloud"))
    }
    const mode = yield* Effect.promise(() => resolveQcMode())
    print(mode)
  }),
})

const QcDisconnectCommand = effectCmd({
  command: "disconnect",
  describe: "remove stored QuantConnect API credentials",
  handler: Effect.fn("Cli.qc.disconnect")(function* () {
    yield* Effect.promise(() => disconnectQcCredentials())
    print({ connected: false, removed: true })
  }),
})
