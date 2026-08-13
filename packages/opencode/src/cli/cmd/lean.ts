import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { LeanAdapter } from "@/backtest/lean/adapter"
import {
  isLeanEnabledSync,
  leanConfigStatus,
  setLeanEnabled,
  LEAN_ADAPTER_CERT_VALUE,
} from "@/backtest/lean/lean-config"

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function readiness() {
  const probe = new LeanAdapter().probeReady()
  return { ready: probe.ready, reasons: probe.reasons }
}

export const LeanCommand = cmd({
  command: "lean",
  describe: "manage the native LEAN backtest engine",
  builder: (yargs) =>
    yargs
      .command(LeanStatusCommand)
      .command(LeanEnableCommand)
      .command(LeanDisableCommand)
      .demandCommand(),
  async handler() {},
})

const LeanStatusCommand = effectCmd({
  command: "status",
  describe: "show LEAN engine config, effective state, and readiness",
  handler: Effect.fn("Cli.lean.status")(function* () {
    const status = yield* Effect.promise(() => leanConfigStatus())
    print({
      ...status,
      certified: status.adapterCert === LEAN_ADAPTER_CERT_VALUE,
      enabledEffective: isLeanEnabledSync(),
      readiness: readiness(),
    })
  }),
})

const LeanEnableCommand = effectCmd({
  command: "enable",
  describe: "enable the LEAN engine (persisted; adapter certificate pinned to the certified value)",
  handler: Effect.fn("Cli.lean.enable")(function* () {
    yield* Effect.promise(() => setLeanEnabled(true))
    const status = yield* Effect.promise(() => leanConfigStatus())
    print({ ...status, readiness: readiness() })
  }),
})

const LeanDisableCommand = effectCmd({
  command: "disable",
  describe: "disable the LEAN engine (persisted)",
  handler: Effect.fn("Cli.lean.disable")(function* () {
    yield* Effect.promise(() => setLeanEnabled(false))
    const status = yield* Effect.promise(() => leanConfigStatus())
    print({ ...status, readiness: readiness() })
  }),
})
