import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { bindSessionWorkspace, clearSessionWorkspace } from "@finny-ai/core/algo"
import { Auth } from "../../src/auth"
import { generateAlpacaProviderID } from "../../src/live/brokers/alpaca"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

// Mirrors test.skipIf(process.platform === "win32") from the original suite.
const live = process.platform === "win32" ? it.live.skip : it.live

const initShell = Effect.fn("ShellDataAgentTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellDataAgentTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = dataCtx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellDataAgentTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = dataCtx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const dataCtx = {
  ...ctx,
  agent: "data_extractor",
}
const sentimentCtx = {
  ...ctx,
  agent: "sentiment_agent",
}
let testSessionCounter = 0
let envLock: Promise<void> = Promise.resolve()

const dataContext = (): Tool.Context => ({
  ...dataCtx,
  sessionID: SessionID.make(`ses_shell_data_${process.pid}_${++testSessionCounter}`),
})

const sentimentContext = (): Tool.Context => ({
  ...sentimentCtx,
  sessionID: SessionID.make(`ses_shell_sentiment_${process.pid}_${++testSessionCounter}`),
})

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`

const withEnvMutationLock = Effect.acquireRelease(
  Effect.promise(async () => {
    const previous = envLock.catch(() => {})
    let release!: () => void
    envLock = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await previous
    return release
  }),
  (release) => Effect.sync(release),
)

// Sets an env var for the duration of the test scope, restoring on close.
const withEnv = (key: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prev = process.env[key]
      process.env[key] = value
      return prev
    }),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }),
  )

// Binds the session workspace for the test scope; cleared when the scope closes.
const withWorkspace = (next: Tool.Context, workspace: string) =>
  Effect.acquireRelease(
    Effect.promise(() => bindSessionWorkspace(next.sessionID, workspace)),
    () => Effect.promise(() => clearSessionWorkspace(next.sessionID).catch(() => {})),
  )

// XDG_DATA_HOME pointed at a fresh tmpdir + session workspace binding.
const sessionWorkspace = (next: Tool.Context, init?: (dir: string) => Promise<void>, workspace = "aapl-breakout") =>
  Effect.gen(function* () {
    yield* withEnvMutationLock
    const xdg = yield* tmpdirScoped({
      init: (dir) => Effect.promise(async () => init?.(dir)),
    })
    yield* withEnv("XDG_DATA_HOME", xdg)
    yield* withWorkspace(next, workspace)
    return xdg
  })

describe("tool.shell data_extractor write guard", () => {
  live("blocks Data Agent bash when no session workspace is bound", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => clearSessionWorkspace(dataCtx.sessionID).catch(() => {}))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = yield* fail({
            command: "printf ok",
            description: "Run without workspace",
          })
          expect(err.message).toContain("Data Agent bash blocked: no session workspace is bound")
        }),
      )
    }),
  )

  live("loads arbitrary project .env values without an allowlist", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            Bun.write(
              path.join(dir, ".env"),
              "ENTERPRISE_RANDOM_SECRET=from_dotenv\nPOLYGON_API_KEY=polygon_dotenv\n",
            ).then(() => {}),
          ),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: 'printf "$ENTERPRISE_RANDOM_SECRET:$POLYGON_API_KEY"',
              workdir: tmp,
              description: "Print data env values",
            },
            next,
          )
          expect(result.output).toContain("from_dotenv:polygon_dotenv")
        }),
      )
    }),
  )

  live("lets exported env override project .env values", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            Bun.write(path.join(dir, ".env"), "ENTERPRISE_RANDOM_SECRET=from_dotenv\n").then(() => {}),
          ),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* withEnv("ENTERPRISE_RANDOM_SECRET", "from_export")
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: 'printf "$ENTERPRISE_RANDOM_SECRET"',
              workdir: tmp,
              description: "Print exported env value",
            },
            next,
          )
          expect(result.output).toContain("from_export")
        }),
      )
    }),
  )

  live("blocks yfinance probes for equity 5m windows beyond public lookback", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        const workspacePath = path.join(dir, "finny/algos/aapl-breakout")
        await fs.mkdir(path.join(workspacePath, "data/stock"), { recursive: true })
        await Bun.write(
          path.join(workspacePath, "request.json"),
          JSON.stringify({
            requested_symbol: "SPY",
            requested_interval: "5m",
            requested_asset_class: "equity",
            requested_start: "2026-03-13",
            requested_end: "2026-06-13",
          }),
        )
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: "python3 -c 'import yfinance as yf; print(yf.Ticker(\"SPY\"))'",
              workdir: path.join(xdg, "finny/algos/aapl-breakout/data"),
              description: "Probe yfinance",
            },
            next,
          )
          expect(err.message).toContain("provider capability preflight forbids yfinance")
          expect(err.message).toContain("requested_start=2026-03-13")
          expect(err.message).toContain("requested_end=2026-06-13")
          expect(err.message).toContain("do not install yfinance or run partial-window diagnostics")

          const importErr = yield* fail(
            {
              command: "python3 -c 'import yfinance'",
              workdir: path.join(xdg, "finny/algos/aapl-breakout/data"),
              description: "Probe yfinance import",
            },
            next,
          )
          expect(importErr.message).toContain("provider capability preflight forbids yfinance")
        }),
      )
    }),
  )

  live("allows yfinance commands when the requested 5m equity window is within public lookback", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        const workspacePath = path.join(dir, "finny/algos/aapl-breakout")
        await fs.mkdir(path.join(workspacePath, "data/stock"), { recursive: true })
        await Bun.write(
          path.join(workspacePath, "request.json"),
          JSON.stringify({
            requested_symbol: "SPY",
            requested_interval: "5m",
            requested_asset_class: "equity",
            requested_start: "2026-05-24",
            requested_end: "2026-06-13",
          }),
        )
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: "printf yfinance",
              workdir: path.join(xdg, "finny/algos/aapl-breakout/data"),
              description: "Mention yfinance",
            },
            next,
          )
          expect(result.output).toBe("yfinance")
        }),
      )
    }),
  )

  live("blocks Data Agent package installation during extraction", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        const workspacePath = path.join(dir, "finny/algos/spy-demo")
        await fs.mkdir(path.join(workspacePath, "data/stock"), { recursive: true })
        await Bun.write(
          path.join(workspacePath, "request.json"),
          JSON.stringify({
            requested_symbol: "SPY",
            requested_interval: "5m",
            requested_asset_class: "equity",
            requested_start: "2026-05-24",
            requested_end: "2026-06-13",
          }),
        )
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: "python3 -m pip install yfinance",
              workdir: path.join(xdg, "finny/algos/spy-demo/data"),
              description: "Install yfinance",
            },
            next,
          )
          expect(err.message).toContain("package installation is disabled")
          expect(err.message).toContain("source/runtime availability issue")
        }),
      )
    }),
  )

  live("allows read-only commands with SQL predicate text", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: `printf '%s\\n' 'select * from bars where close > 10'`,
              workdir: tmp,
              description: "Print read-only SQL query",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("close > 10")
        }),
      )
    }),
  )

  live("blocks model-visible reads of env files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            Bun.write(path.join(dir, ".env.local"), "POLYGON_API_KEY=should_not_surface\n").then(() => {}),
          ),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: "cat .env.local",
              workdir: tmp,
              description: "Read data env file",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash read blocked")
        }),
      )
    }),
  )

  live("blocks unresolved shell-expanded read targets", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const external = yield* tmpdirScoped({
        init: (dir) => Effect.promise(() => Bun.write(path.join(dir, "secret.txt"), "secret\n").then(() => {})),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* withEnv("SECRET_FILE", path.join(external, "secret.txt"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: 'cat "$SECRET_FILE"',
              workdir: tmp,
              description: "Read shell-expanded secret file",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash read blocked")
        }),
      )
    }),
  )

  live("blocks redirects under repo template data", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            fs.mkdir(path.join(dir, "algos/_template/data/stock"), { recursive: true }).then(() => {}),
          ),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const dataDir = path.join(tmp, "algos/_template/data")
          const output = path.join(dataDir, "stock/AAPL.csv")
          const err = yield* fail(
            {
              command: "printf test > stock/AAPL.csv",
              workdir: dataDir,
              description: "Write template stock data",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(output).exists())).toBe(false)
        }),
      )
    }),
  )

  live("can create a bash data artifact with a manifest under data", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const output = path.join(dataDir, "stock/AAPL_1d_2024-01-01_2024-01-02.csv")
          const manifest = path.join(dataDir, "stock/AAPL_1d_2024-01-01_2024-01-02.manifest.json")
          const result = yield* run(
            {
              command: [
                "mkdir -p stock",
                "printf 'timestamp,open,high,low,close,volume\\n2024-01-01,1,2,1,2,100\\n' > stock/AAPL_1d_2024-01-01_2024-01-02.csv",
                'printf \'{"schema_version":1,"source":"fixture","symbols":["AAPL"],"interval":"1d","start":"2024-01-01","end":"2024-01-02","output_path":"stock/AAPL_1d_2024-01-01_2024-01-02.csv","rows":1,"created_at":"2026-06-04T00:00:00Z"}\' > stock/AAPL_1d_2024-01-01_2024-01-02.manifest.json',
              ].join(" && "),
              workdir: dataDir,
              description: "Write bash data artifact and manifest",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(output).text())).toContain("timestamp,open,high,low,close,volume")

          const parsed = JSON.parse(yield* Effect.promise(() => Bun.file(manifest).text()))
          expect(parsed.source).toBe("fixture")
          expect(parsed.symbols).toEqual(["AAPL"])
          expect(parsed.output_path).toBe("stock/AAPL_1d_2024-01-01_2024-01-02.csv")
          expect(parsed.rows).toBe(1)
          expect(parsed).not.toHaveProperty("command_hash")
          expect(parsed).not.toHaveProperty("credential_env_names")
        }),
      )
    }),
  )

  live("allows redirects under the session-bound workspace data root", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const output = path.join(dataDir, "stock/AAPL.csv")
          const result = yield* run(
            {
              command: "printf test > stock/AAPL.csv",
              workdir: dataDir,
              description: "Write algo stock data",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(output).text())).toBe("test")
        }),
      )
    }),
  )

  live("loads algo workspace .env for session-bound Data Agent bash", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        const workspacePath = path.join(dir, "finny/algos/aapl-breakout")
        await fs.mkdir(path.join(workspacePath, "data/stock"), { recursive: true })
        await Bun.write(
          path.join(workspacePath, ".env"),
          "ALPACA_API_KEY_ID=from_algo_workspace\nALPACA_API_SECRET_KEY=algo_secret\n",
        )
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const result = yield* run(
            {
              command: 'printf "%s:%s" "$ALPACA_API_KEY_ID" "$ALPACA_API_SECRET_KEY"',
              workdir: dataDir,
              description: "Print algo workspace env values",
            },
            next,
          )
          expect(result.output).toBe("from_algo_workspace:algo_secret")
        }),
      )
    }),
  )

  live("injects connected Alpaca brokerage credentials into Data Agent bash", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const providerID = generateAlpacaProviderID()
      yield* Effect.promise(() =>
        Auth.set(providerID, {
          type: "api",
          key: "brokerage_secret",
          metadata: {
            keyId: "brokerage_key_id",
            label: "Paper",
            mode: "paper",
          },
        }),
      )
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      try {
        yield* runIn(
          project,
          Effect.gen(function* () {
            const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
            const result = yield* run(
              {
                command: 'printf "%s:%s" "$ALPACA_API_KEY_ID" "$ALPACA_API_SECRET_KEY"',
                workdir: dataDir,
                description: "Print brokerage auth env values",
              },
              next,
            )
            expect(result.output).toBe("brokerage_key_id:brokerage_secret")
          }),
        )
      } finally {
        yield* Effect.promise(() => Auth.remove(providerID))
      }
    }),
  )

  live("prefers workspace venv python3 on PATH for Data Agent bash", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        const workspacePath = path.join(dir, "finny/algos/aapl-breakout")
        const venvBin = path.join(workspacePath, ".venv/bin")
        await fs.mkdir(path.join(workspacePath, "data/stock"), { recursive: true })
        await fs.mkdir(venvBin, { recursive: true })
        await Bun.write(
          path.join(venvBin, "python"),
          "#!/bin/sh\necho from-workspace-venv\n",
        )
        await fs.chmod(path.join(venvBin, "python"), 0o755)
        await fs.symlink("python", path.join(venvBin, "python3"))
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const result = yield* run(
            {
              command: "python3 -c \"print('probe')\"",
              workdir: dataDir,
              description: "Resolve python3 from workspace venv",
            },
            next,
          )
          expect(result.output.trim()).toBe("from-workspace-venv")
        }),
      )
    }),
  )

  live("exposes session workspace env vars to Data Agent bash", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const workspacePath = path.join(xdg, "finny/algos/aapl-breakout")
          const result = yield* run(
            {
              command: 'printf "%s|%s" "$FINNY_STRATEGY_WORKSPACE_NAME" "$FINNY_STRATEGY_WORKSPACE_PATH"',
              workdir: dataDir,
              description: "Print session workspace env vars",
            },
            next,
          )
          expect(result.output).toBe(`aapl-breakout|${workspacePath}`)
        }),
      )
    }),
  )

  live("allows Data Agent bash reads inside the session data root", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        await fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true })
        await Bun.write(
          path.join(dir, "finny/algos/aapl-breakout/data/stock/AAPL.csv"),
          "timestamp,open\n2024-01-01,1\n",
        )
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const result = yield* run(
            {
              command: "head -n 1 stock/AAPL.csv",
              workdir: dataDir,
              description: "Read saved data artifact",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("timestamp,open")
        }),
      )
    }),
  )

  live("exposes the session data root to Data Agent bash", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const result = yield* run(
            {
              command: "printf '%s' \"$ALLOWED_DATA_DIR\"",
              workdir: dataDir,
              description: "Print allowed data dir",
            },
            next,
          )
          expect(result.output).toBe(dataDir)
        }),
      )
    }),
  )

  live("defaults Data Agent bash to the session data root", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const output = path.join(dataDir, "stock/AAPL.csv")
          const result = yield* run(
            {
              command: "printf 'timestamp,open,high,low,close,volume\\n2024-01-01,1,2,1,2,100\\n' > stock/AAPL.csv",
              description: "Write default cwd data",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(output).text())).toContain("2024-01-01,1,2,1,2,100")
          const count = yield* run(
            {
              command: "wc -l stock/AAPL.csv",
              description: "Count data artifact rows",
            },
            next,
          )
          expect(count.metadata.exit).toBe(0)
          expect(count.output).toContain("stock/AAPL.csv")
        }),
      )
    }),
  )

  live("allows Data Agent bash ls on the session workspace root", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, async (dir) => {
        await fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true })
        await Bun.write(path.join(dir, "finny/algos/aapl-breakout/mission.md"), "# Mission\n")
      })
      yield* runIn(
        project,
        Effect.gen(function* () {
          const workspacePath = path.join(xdg, "finny/algos/aapl-breakout")
          const result = yield* run(
            {
              command: `ls -la ${quote(workspacePath)}`,
              description: "List session workspace root",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("data")
          expect(result.output).toContain("mission.md")
        }),
      )
    }),
  )

  live("blocks Data Agent bash reads of repo-local algos", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            fs.mkdir(path.join(dir, "algos/spy-5min-momentum/data"), { recursive: true }).then(() => {}),
          ),
      })
      const next = dataContext()
      yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const repoAlgoDir = path.join(project, "algos/spy-5min-momentum")
          const err = yield* fail(
            {
              command: `ls ${quote(repoAlgoDir)}`,
              description: "List package algos directory",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash read blocked")
        }),
      )
    }),
  )

  live("blocks tmp helper scripts even when final output is under data", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const tmpScript = path.join(os.tmpdir(), `finny-fetch-${Date.now()}.py`)
          const err = yield* fail(
            {
              command: [
                `cat > ${quote(tmpScript)} <<'PY'`,
                "print('x')",
                "PY",
                `python3 ${quote(tmpScript)} > stock/SPY.csv`,
              ].join("\n"),
              description: "Write tmp helper script",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(tmpScript).exists())).toBe(false)
        }),
      )
    }),
  )

  live("blocks redirects outside data roots", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const external = yield* tmpdirScoped()
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        project,
        Effect.gen(function* () {
          const outside = path.join(external, "outside.csv")
          const err = yield* fail(
            {
              command: `echo test > ${quote(outside)}`,
              description: "Write outside data root",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(outside).exists())).toBe(false)
        }),
      )
    }),
  )

  live("blocks downloader output flags outside data roots", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const external = yield* tmpdirScoped()
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        project,
        Effect.gen(function* () {
          const outside = path.join(external, "bars.csv")
          const err = yield* fail(
            {
              command: `curl -fsS -o ${quote(outside)} https://example.com/bars.csv`,
              description: "Download outside data root",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(outside).exists())).toBe(false)
        }),
      )
    }),
  )

  live("blocks mutating commands outside data roots", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(async () => {
            await fs.mkdir(path.join(dir, "algos/_template/data/stock"), { recursive: true })
            await Bun.write(path.join(dir, "algos/_template/data/stock/source.csv"), "x")
          }),
      })
      const external = yield* tmpdirScoped({
        init: (dir) => Effect.promise(() => Bun.write(path.join(dir, "remove.csv"), "x").then(() => {})),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(project, "algos/_template/data")
          const commands = [
            `mkdir ${quote(path.join(external, "outside-dir"))}`,
            `touch ${quote(path.join(external, "touch.csv"))}`,
            `printf test | tee ${quote(path.join(external, "tee.csv"))}`,
            `cp stock/source.csv ${quote(path.join(external, "copy.csv"))}`,
            `mv stock/source.csv ${quote(path.join(external, "move.csv"))}`,
            `rm ${quote(path.join(external, "remove.csv"))}`,
          ]
          for (const command of commands) {
            const err = yield* fail(
              {
                command,
                workdir: dataDir,
                description: "Mutate outside data root",
              },
              next,
            )
            expect(err.message).toContain("Data Agent bash write blocked")
          }
        }),
      )
    }),
  )

  live("allows null-device redirects", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        project,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: "printf test > /dev/null",
              workdir: project,
              description: "Write to null sink",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
        }),
      )
    }),
  )

  live("blocks writes under packages/opencode/data/news", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() => fs.mkdir(path.join(dir, "packages/opencode/data/news/body"), { recursive: true })),
      })
      const next = dataContext()
      yield* sessionWorkspace(next)
      yield* runIn(
        project,
        Effect.gen(function* () {
          const newsPath = path.join(project, "packages/opencode/data/news/body/spy.md")
          const err = yield* fail(
            {
              command: `printf test > ${quote(newsPath)}`,
              description: "Write repo news path",
            },
            next,
          )
          expect(err.message).toContain("Data Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(newsPath).exists())).toBe(false)
        }),
      )
    }),
  )

  live("allows inline python heredoc writes under workspace data", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = dataContext()
      const xdg = yield* sessionWorkspace(next, (dir) =>
        fs.mkdir(path.join(dir, "finny/algos/aapl-breakout/data/stock"), { recursive: true }).then(() => {}),
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const dataDir = path.join(xdg, "finny/algos/aapl-breakout/data")
          const output = path.join(dataDir, "stock/heredoc.csv")
          const result = yield* run(
            {
              command: [
                "mkdir -p stock",
                "python3 <<'PY' > stock/heredoc.csv",
                "print('timestamp,open,high,low,close,volume')",
                "print('2024-01-01,1,2,1,2,100')",
                "PY",
              ].join("\n"),
              workdir: dataDir,
              description: "Inline python heredoc write",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(output).text())).toContain("timestamp,open,high,low,close,volume")
        }),
      )
    }),
  )

  live("does not affect non-data agents", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const external = yield* tmpdirScoped()
      yield* runIn(
        project,
        Effect.gen(function* () {
          const outside = path.join(external, "outside.csv")
          const result = yield* run(
            {
              command: `printf ok > ${quote(outside)}`,
              description: "Write external output",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(outside).text())).toBe("ok")
        }),
      )
    }),
  )
})

describe("tool.shell sentiment_agent write guard", () => {
  live("allows sentiment_agent bash writes under workspace data/sentiment/body", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = sentimentContext()
      const xdg = yield* sessionWorkspace(
        next,
        (dir) =>
          fs
            .mkdir(path.join(dir, "finny/algos/aapl-sentiment/data/sentiment/body"), { recursive: true })
            .then(() => {}),
        "aapl-sentiment",
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const output = path.join(
            xdg,
            "finny/algos/aapl-sentiment/data/sentiment/body/AAPL_2026-06-01_2026-06-29_sentiment.csv",
          )
          const result = yield* run(
            {
              command: `printf 'date,symbol,source\\n' > ${quote(output)}`,
              description: "Write sentiment aggregate",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(output).text())).toBe("date,symbol,source\n")
        }),
      )
    }),
  )

  live("blocks sentiment_agent bash writes outside workspace data/sentiment/body", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = sentimentContext()
      const xdg = yield* sessionWorkspace(
        next,
        (dir) =>
          fs
            .mkdir(path.join(dir, "finny/algos/aapl-sentiment/data/sentiment/headlines"), { recursive: true })
            .then(() => {}),
        "aapl-sentiment",
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const output = path.join(xdg, "finny/algos/aapl-sentiment/data/sentiment/headlines/AAPL.md")
          const err = yield* fail(
            {
              command: `printf wrong > ${quote(output)}`,
              description: "Write sentiment headline",
            },
            next,
          )
          expect(err.message).toContain("Sentiment Agent bash write blocked")
          expect(yield* Effect.promise(() => Bun.file(output).exists())).toBe(false)
        }),
      )
    }),
  )

  live("blocks sentiment_agent Python scripts that can hide filesystem writes", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = sentimentContext()
      const xdg = yield* sessionWorkspace(
        next,
        (dir) =>
          fs
            .mkdir(path.join(dir, "finny/algos/aapl-sentiment/data/sentiment/body"), { recursive: true })
            .then(() => {}),
        "aapl-sentiment",
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const output = path.join(xdg, "finny/algos/aapl-sentiment/data/sentiment/headlines/AAPL.md")
          const err = yield* fail(
            {
              command: `python3 -c "open(${JSON.stringify(output)}, 'w').write('raw text')"`,
              description: "Write sentiment via Python",
            },
            next,
          )
          expect(err.message).toContain("Python interpreter commands can hide file writes")
          expect(yield* Effect.promise(() => Bun.file(output).exists())).toBe(false)
        }),
      )
    }),
  )

  live("allows sentiment_agent read-only Python parsing to stdout", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = sentimentContext()
      yield* sessionWorkspace(
        next,
        (dir) =>
          fs
            .mkdir(path.join(dir, "finny/algos/aapl-sentiment/data/sentiment/body"), { recursive: true })
            .then(() => {}),
        "aapl-sentiment",
      )
      yield* runIn(
        project,
        Effect.gen(function* () {
          const result = yield* run(
            {
              command: `python3 -c "import json; print(json.loads('{\\\"mentions\\\": 7}')['mentions'])"`,
              description: "Parse sentiment JSON",
            },
            next,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output.trim()).toBe("7")
        }),
      )
    }),
  )

  live("blocks sentiment_agent bash reads of env files", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped({
        init: (dir) =>
          Effect.promise(() =>
            Bun.write(path.join(dir, ".env.local"), "POLYGON_API_KEY=should_not_surface\n").then(() => {}),
          ),
      })
      const next = sentimentContext()
      yield* sessionWorkspace(next, undefined, "aapl-sentiment")
      yield* runIn(
        project,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: "cat .env.local",
              description: "Read sentiment env file",
            },
            next,
          )
          expect(err.message).toContain("Sentiment Agent bash read blocked")
        }),
      )
    }),
  )

  live("blocks sentiment_agent credential-like environment output", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped()
      const next = sentimentContext()
      yield* sessionWorkspace(next, undefined, "aapl-sentiment")
      yield* withEnv("POLYGON_API_KEY", "should_not_surface")
      yield* runIn(
        project,
        Effect.gen(function* () {
          const err = yield* fail(
            {
              command: 'printf "%s\\n" "$POLYGON_API_KEY"',
              description: "Print sentiment credential",
            },
            next,
          )
          expect(err.message).toContain("Sentiment Agent bash read blocked")
        }),
      )
    }),
  )
})
