import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import {
  connectQcCredentials,
  disconnectQcCredentials,
  qcConnectionState,
} from "@/integration/quantconnect"

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
      .demandCommand(),
  async handler() {},
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
