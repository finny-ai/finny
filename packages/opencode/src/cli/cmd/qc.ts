import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import {
  connectQcCredentials,
  disconnectQcCredentials,
  qcConnectionState,
} from "@/integration/quantconnect"
import { runQcCloudBacktest, deployQcPaper, stopQcPaper, listPaperDeployments } from "@/integration/qc-cloud"
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
      .command(QcDisconnectCommand)
      .command(QcBacktestCommand)
      .command(QcPaperDeployCommand)
      .command(QcPaperListCommand)
      .command(QcPaperStopCommand)
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
    print(yield* Effect.promise(() => qcConnectionState()))
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
