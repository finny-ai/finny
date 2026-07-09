import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { BacktestStore } from "@/backtest/store"
import { Algorithm } from "@/algorithm"

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function looksLikeAlgorithmId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) || /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)
}

async function backtestFilters(input: string | undefined) {
  if (!input) return {}
  if (looksLikeAlgorithmId(input)) return { algorithmId: input }

  const resolved = await Algorithm.resolve(input)
  if (resolved) return { algorithmName: resolved.name }
  return { algorithmName: input }
}

export const BacktestCommand = cmd({
  command: "backtest",
  describe: "inspect saved backtest runs",
  builder: (yargs: Argv) => yargs.command(BacktestListCommand).command(BacktestShowCommand).demandCommand(),
  async handler() {},
})

const BacktestListCommand = effectCmd({
  command: "list",
  describe: "list saved backtest runs",
  builder: (yargs) =>
    yargs
      .option("algorithm", {
        type: "string",
        describe: "filter by algorithm name or ID",
      })
      .option("limit", {
        type: "number",
        default: 50,
        describe: "max runs to return",
      }),
  handler: Effect.fn("Cli.backtest.list")(function* (args) {
    const filters = yield* Effect.promise(() => backtestFilters(args.algorithm))
    const runs = yield* Effect.promise(() => BacktestStore.list({ ...filters, limit: args.limit }))
    print(runs)
  }),
})

const BacktestShowCommand = effectCmd({
  command: "show <runID>",
  describe: "show a saved backtest run manifest",
  builder: (yargs) =>
    yargs.positional("runID", {
      type: "string",
      demandOption: true,
      describe: "backtest run ID",
    }),
  handler: Effect.fn("Cli.backtest.show")(function* (args) {
    const run = yield* Effect.promise(() => BacktestStore.get(args.runID))
    if (!run) return yield* fail(`Backtest run not found: ${args.runID}`)
    print(run)
  }),
})
