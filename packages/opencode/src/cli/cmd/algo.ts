import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Algorithm } from "@/algorithm"
import { Validate } from "@/algorithm/validate"
import { BacktestRunner } from "@/backtest/runner"
import { BacktestStore } from "@/backtest/store"
import { Filesystem } from "@/util/filesystem"

type SavedAlgorithm = Awaited<ReturnType<typeof Algorithm.resolve>> extends infer T ? Exclude<T, null> : never

type BacktestArgs = {
  duration: string
  interval: string
  capital: string
  startDate?: string
  endDate?: string
  dataQualityMode: "strict" | "repair_outliers"
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

async function readText(text: string | undefined, file: string | undefined, label: string): Promise<string | undefined> {
  if (text && file) throw new Error(`Pass either --${label} or --${label}-file, not both`)
  if (text) return text
  if (file) return await Filesystem.readText(file)
  return undefined
}

async function requireAlgorithm(identifier: string, version?: number): Promise<SavedAlgorithm> {
  const resolved = await Algorithm.resolve(identifier)
  if (!resolved) throw new Error(`Algorithm not found: ${identifier}`)
  if (version === undefined) return resolved
  const exact = await Algorithm.getVersion(resolved.algorithmId, version)
  if (!exact) throw new Error(`Algorithm ${resolved.name} has no version ${version}`)
  return exact as SavedAlgorithm
}

function serializeAlgorithm(algo: SavedAlgorithm) {
  return {
    algorithmId: algo.algorithmId,
    name: algo.name,
    version: algo.version,
    status: algo.status,
    language: algo.language,
    description: algo.description,
    targetBrokerage: algo.targetBrokerage,
    brokerKind: algo.brokerKind,
    timeCreated: algo.time_created,
    timeUpdated: algo.time_updated,
    config: algo.config,
    reasoning: algo.reasoning,
  }
}

function summarizeValidation(result: Awaited<ReturnType<typeof Validate.run>>) {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary: Validate.format(result),
  }
}

function summarizeBacktest(algo: SavedAlgorithm, params: BacktestArgs, result: Awaited<ReturnType<typeof BacktestRunner.run>>) {
  if (!result.ok) {
    return {
      ok: false,
      algorithm: { name: algo.name, version: algo.version },
      params,
      error: result.error,
    }
  }
  const run = result.results
  return {
    ok: true,
    algorithm: { name: algo.name, version: algo.version },
    params,
    runId: run.runId,
    artifactDir: run.artifactDir,
    evidenceDir: run.evidenceDir,
    productLabel: run.productLabel,
    runKind: run.runKind,
    eligibilityStatus: run.eligibilityStatus,
    symbol: run.v2?.symbols?.[0] ?? null,
    metrics: {
      totalReturn: run.totalReturn,
      maxDrawdown: run.maxDrawdown,
      sharpeRatio: run.sharpeRatio,
      endingEquity: run.endingEquity,
      totalTrades: run.totalTrades,
      winRate: run.winRate,
      profitFactor: run.profitFactor,
      annualizedVolatility: run.annualizedVolatility,
      benchmarkReturn: run.benchmarkReturn,
      alpha: run.alpha,
      barsProcessed: run.diagnostics?.barsProcessed ?? run.v2?.bars_processed ?? null,
    },
  }
}

function isNewerVersion(candidate: SavedAlgorithm, previous: SavedAlgorithm | undefined) {
  if (!previous) return true
  if (candidate.version !== previous.version) return candidate.version > previous.version
  return candidate.time_updated > previous.time_updated
}

function latestAlgorithms(algorithms: SavedAlgorithm[]) {
  const latest = new Map<string, SavedAlgorithm>()
  for (const algorithm of algorithms) {
    const previous = latest.get(algorithm.name)
    if (isNewerVersion(algorithm, previous)) latest.set(algorithm.name, algorithm)
  }
  return Array.from(latest.values()).sort((a, b) => b.time_updated - a.time_updated)
}

async function allAlgorithms(algorithms: SavedAlgorithm[]) {
  const versions = await Promise.all(algorithms.map((algorithm) => Algorithm.listVersions(algorithm.algorithmId)))
  return versions
    .flat()
    .sort((a, b) => (b.time_updated - a.time_updated) || (b.version - a.version)) as SavedAlgorithm[]
}

async function readOptionalFile(path: string | undefined) {
  return path ? await Filesystem.readText(path) : undefined
}

async function loadAlgorithmPayload(args: {
  code?: string
  file?: string
  config?: string
  "config-file"?: string
  reasoning?: string
  "reasoning-file"?: string
  "mission-file"?: string
  "prefs-file"?: string
  "decisions-file"?: string
}) {
  const code = await readText(args.code, args.file, "code")
  if (!code) throw new Error("Pass --code or --file")
  return {
    code,
    config: await readText(args.config, args["config-file"], "config"),
    reasoning: await readText(args.reasoning, args["reasoning-file"], "reasoning"),
    mission: await readOptionalFile(args["mission-file"]),
    prefs: await readOptionalFile(args["prefs-file"]),
    decisions: await readOptionalFile(args["decisions-file"]),
  }
}

function backtestParams(args: {
  duration: string
  interval: string
  capital: string
  "start-date"?: string
  "end-date"?: string
  "data-quality-mode": "strict" | "repair_outliers"
}): BacktestArgs {
  return {
    duration: args.duration,
    interval: args.interval,
    capital: args.capital,
    startDate: args["start-date"],
    endDate: args["end-date"],
    dataQualityMode: args["data-quality-mode"],
  }
}

async function maybeValidation(algorithm: SavedAlgorithm, enabled: boolean) {
  if (!enabled) return undefined
  return summarizeValidation(await Validate.run(algorithm.code, { config: algorithm.config }))
}

async function maybeBacktest(algorithm: SavedAlgorithm, enabled: boolean, params: BacktestArgs) {
  if (!enabled) return undefined
  const result = await BacktestRunner.run({
    algorithm,
    duration: params.duration,
    interval: params.interval,
    capital: params.capital,
    startDate: params.startDate,
    endDate: params.endDate,
    dataQualityMode: params.dataQualityMode,
    robustness: { monteCarloPaths: 500, regimes: true },
  })
  return summarizeBacktest(algorithm, params, result)
}

export const AlgoCommand = cmd({
  command: "algo",
  describe: "manage algorithms and their versions",
  builder: (yargs: Argv) =>
    yargs
      .command(AlgoListCommand)
      .command(AlgoShowCommand)
      .command(AlgoVersionsCommand)
      .command(AlgoAddCommand)
      .command(AlgoValidateCommand)
      .command(AlgoBacktestCommand)
      .demandCommand(),
  async handler() {},
})

const AlgoListCommand = effectCmd({
  command: "list",
  describe: "list saved algorithms",
  builder: (yargs) =>
    yargs.option("all-versions", {
      type: "boolean",
      default: false,
      describe: "include every saved version instead of latest only",
    }),
  handler: Effect.fn("Cli.algo.list")(function* (args) {
    const algorithms = (yield* Effect.promise(() => Algorithm.list())) as SavedAlgorithm[]
    if (Boolean(args["all-versions"])) {
      return print((yield* Effect.promise(() => allAlgorithms(algorithms))).map(serializeAlgorithm))
    }

    print(latestAlgorithms(algorithms).map(serializeAlgorithm))
  }),
})

const AlgoShowCommand = effectCmd({
  command: "show <algorithm>",
  describe: "show a saved algorithm",
  builder: (yargs) =>
    yargs
      .positional("algorithm", {
        type: "string",
        demandOption: true,
        describe: "algorithm name or ID",
      })
      .option("algo-version", {
        type: "number",
        describe: "specific version to load",
      }),
  handler: Effect.fn("Cli.algo.show")(function* (args) {
    const algorithm = yield* Effect.promise(() => requireAlgorithm(args.algorithm, args["algo-version"]))
    print(serializeAlgorithm(algorithm))
  }),
})

const AlgoVersionsCommand = effectCmd({
  command: "versions <algorithm>",
  describe: "list all saved versions for an algorithm",
  builder: (yargs) =>
    yargs.positional("algorithm", {
      type: "string",
      demandOption: true,
      describe: "algorithm name or ID",
    }),
  handler: Effect.fn("Cli.algo.versions")(function* (args: { algorithm: string }) {
    const algorithm = yield* Effect.promise(() => requireAlgorithm(args.algorithm))
    const versions = yield* Effect.promise(() => Algorithm.listVersions(algorithm.algorithmId))
    print(versions.sort((a, b) => b.version - a.version).map((item) => serializeAlgorithm(item as SavedAlgorithm)))
  }),
})

const algoAddOptionSpecs = [
  ["name", { type: "string", demandOption: true, describe: "algorithm name" }],
  ["code", { type: "string", describe: "inline strategy source code" }],
  ["file", { type: "string", describe: "path to strategy source file" }],
  ["config", { type: "string", describe: "inline config JSON" }],
  ["config-file", { type: "string", describe: "path to config JSON file" }],
  ["description", { type: "string", describe: "algorithm description" }],
  [
    "save-mode",
    {
      type: "string",
      choices: ["new", "version"] as const,
      default: "new",
      describe: "create a new algorithm or bump an existing version",
    },
  ],
  ["language", { type: "string", default: "python", describe: "strategy language" }],
  ["reasoning", { type: "string", describe: "inline reasoning markdown" }],
  ["reasoning-file", { type: "string", describe: "path to reasoning markdown" }],
  ["mission-file", { type: "string", describe: "path to mission.md" }],
  ["prefs-file", { type: "string", describe: "path to prefs.md" }],
  ["decisions-file", { type: "string", describe: "path to decisions.md" }],
  [
    "target-brokerage",
    {
      type: "string",
      choices: ["alpaca", "binance", "ibkr"] as const,
      describe: "optional target brokerage metadata",
    },
  ],
  ["validate", { type: "boolean", default: false, describe: "validate immediately after saving" }],
  ["backtest", { type: "boolean", default: false, describe: "run a backtest immediately after saving" }],
  ["duration", { type: "string", default: "3m", describe: "backtest duration when --backtest is used" }],
  ["interval", { type: "string", default: "1h", describe: "backtest interval when --backtest is used" }],
  ["capital", { type: "string", default: "10000", describe: "backtest capital when --backtest is used" }],
  ["start-date", { type: "string", describe: "exact backtest start date YYYY-MM-DD" }],
  ["end-date", { type: "string", describe: "exact backtest end date YYYY-MM-DD" }],
  [
    "data-quality-mode",
    {
      type: "string",
      choices: ["strict", "repair_outliers"] as const,
      default: "strict",
      describe: "backtest data quality mode when --backtest is used",
    },
  ],
] as const

function buildAlgoAddCommand(yargs: Argv) {
  return algoAddOptionSpecs.reduce((cmd, [name, config]) => cmd.option(name, config), yargs)
}

const handleAlgoAdd = Effect.fn("Cli.algo.add")(function* (args) {
  try {
    const payload = yield* Effect.promise(() => loadAlgorithmPayload(args))
    const params = backtestParams(args)
    const saved = yield* Effect.promise(() =>
      Algorithm.save({
        name: args.name,
        code: payload.code,
        language: args.language,
        description: args.description,
        config: payload.config,
        reasoning: payload.reasoning,
        mission: payload.mission,
        prefs: payload.prefs,
        decisions: payload.decisions,
        saveMode: args["save-mode"],
        targetBrokerage: args["target-brokerage"],
      }),
    )
    const resolved = (yield* Effect.promise(() => requireAlgorithm(saved.algorithmId, saved.version))) as SavedAlgorithm
    const validation = yield* Effect.promise(() => maybeValidation(resolved, args.validate))
    const backtest = yield* Effect.promise(() => maybeBacktest(resolved, args.backtest, params))
    print({
      saved: serializeAlgorithm(resolved),
      ...(validation ? { validation } : {}),
      ...(backtest ? { backtest } : {}),
    })
  } catch (error) {
    return yield* fail(error instanceof Error ? error.message : String(error))
  }
})

const AlgoAddCommand = effectCmd({
  command: "add",
  describe: "add a new algorithm or save a new version",
  builder: buildAlgoAddCommand,
  handler: handleAlgoAdd,
})

const AlgoValidateCommand = effectCmd({
  command: "validate <algorithm>",
  describe: "validate a saved algorithm version",
  builder: (yargs) =>
    yargs
      .positional("algorithm", {
        type: "string",
        demandOption: true,
        describe: "algorithm name or ID",
      })
      .option("algo-version", {
        type: "number",
        describe: "specific version to validate",
      }),
  handler: Effect.fn("Cli.algo.validate")(function* (args) {
    const algorithm = yield* Effect.promise(() => requireAlgorithm(args.algorithm, args["algo-version"]))
    const result = yield* Effect.promise(() => Validate.run(algorithm.code, { config: algorithm.config }))
    print({
      algorithm: { name: algorithm.name, version: algorithm.version, algorithmId: algorithm.algorithmId },
      ...summarizeValidation(result),
    })
  }),
})

const AlgoBacktestCommand = effectCmd({
  command: "backtest <algorithm>",
  describe: "run a backtest for a saved algorithm version",
  builder: (yargs) =>
    yargs
      .positional("algorithm", {
        type: "string",
        demandOption: true,
        describe: "algorithm name or ID",
      })
      .option("algo-version", {
        type: "number",
        describe: "specific version to backtest",
      })
      .option("duration", {
        type: "string",
        default: "3m",
        describe: "backtest duration",
      })
      .option("interval", {
        type: "string",
        default: "1h",
        describe: "backtest interval",
      })
      .option("capital", {
        type: "string",
        default: "10000",
        describe: "starting capital",
      })
      .option("start-date", {
        type: "string",
        describe: "exact backtest start date YYYY-MM-DD",
      })
      .option("end-date", {
        type: "string",
        describe: "exact backtest end date YYYY-MM-DD",
      })
      .option("data-quality-mode", {
        type: "string",
        choices: ["strict", "repair_outliers"] as const,
        default: "strict",
        describe: "data quality mode",
      }),
  handler: Effect.fn("Cli.algo.backtest")(function* (args) {
    const algorithm = yield* Effect.promise(() => requireAlgorithm(args.algorithm, args["algo-version"]))
    const params = backtestParams(args)
    const result = yield* Effect.promise(() =>
      BacktestRunner.run({
        algorithm,
        duration: params.duration,
        interval: params.interval,
        capital: params.capital,
        startDate: params.startDate,
        endDate: params.endDate,
        dataQualityMode: params.dataQualityMode,
        robustness: { monteCarloPaths: 500, regimes: true },
      }),
    )
    print(summarizeBacktest(algorithm, params, result))
  }),
})
