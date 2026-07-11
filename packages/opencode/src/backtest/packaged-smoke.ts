import crypto from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { BacktestRunner } from "./runner"
import { ensurePythonEnv } from "@/python/env"
import { Process } from "@/util/process"

export namespace PackagedBacktestSmoke {
  export interface Result {
    engineTreeSha256: string
    rawDataSha256: string
    processedDataSha256: string
    resultSha256: string
    tradesSha256: string
    pythonVersion: string
    installedPackagesSha256: string
  }

  const CSV = [
    "timestamp,open,high,low,close,volume",
    "2026-01-05T14:30:00Z,100,101,99,100,1000000",
    "2026-01-06T14:30:00Z,101,102,100,101,1000000",
    "2026-01-07T14:30:00Z,102,103,101,102,1000000",
    "2026-01-08T14:30:00Z,103,104,102,103,1000000",
    "2026-01-09T14:30:00Z,104,105,103,104,1000000",
  ].join("\n")

  const CONFIG = JSON.stringify(
    {
      symbol: "SPY",
      asset_class: "equity",
      interval: "1d",
      risk: { starting_equity_usd: 10_000 },
      execution: { spread_enabled: false, taker_fee_bps: 0, slippage_bps: 0, k_vol: 0 },
    },
    null,
    2,
  )

  const STRATEGY = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.n = 0

    def on_bar(self, symbol, bar):
        if self.n == 0:
            self.broker.buy(symbol, qty=1, tag="entry")
        elif self.n == 2:
            self.broker.sell(symbol, qty=1, tag="exit")
        self.n += 1
`

  function sha256(value: string | Buffer): string {
    return crypto.createHash("sha256").update(value).digest("hex")
  }

  async function filesUnder(root: string, prefix = ""): Promise<Array<{ path: string; bytes: Buffer }>> {
    const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
    const output: Array<{ path: string; bytes: Buffer }> = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix.replaceAll("\\", "/"), entry.name)
      if (entry.isDirectory()) output.push(...(await filesUnder(root, relative)))
      else if (entry.isFile()) output.push({ path: relative, bytes: await fs.readFile(path.join(root, relative)) })
    }
    return output
  }

  async function treeHash(root: string): Promise<string> {
    const hash = crypto.createHash("sha256")
    for (const file of (await filesUnder(root)).filter((entry) => entry.path.endsWith(".py"))) {
      hash.update(file.path)
      hash.update("\0")
      hash.update(file.bytes)
      hash.update("\0")
    }
    return hash.digest("hex")
  }

  async function materializeEngine(destination: string): Promise<void> {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine_v2")
    try {
      const files = (await filesUnder(source)).filter((entry) => entry.path.endsWith(".py"))
      if (files.length === 0) throw new Error("empty source engine")
      for (const file of files) {
        const target = path.join(destination, file.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.bytes)
      }
      return
    } catch {
      // Packaged binaries do not have a source tree beside the executable.
    }
    if (!(await BacktestRunner.materializeBundledEngineV2(destination))) {
      throw new Error("engine_v2 was neither present in the source checkout nor embedded in this executable")
    }
  }

  async function python(options: { python?: string }): Promise<string> {
    if (options.python) return options.python.includes(path.sep) ? path.resolve(options.python) : options.python
    if (process.env.FINNY_ENGINE_SMOKE_PYTHON) {
      const configured = process.env.FINNY_ENGINE_SMOKE_PYTHON
      return configured.includes(path.sep) ? path.resolve(configured) : configured
    }
    const env = await ensurePythonEnv([
      { spec: "numpy", importCheck: "numpy" },
      { spec: "pandas", importCheck: "pandas" },
      { spec: "scipy", importCheck: "scipy" },
      { spec: "pydantic", importCheck: "pydantic" },
      { spec: "pyarrow", importCheck: "pyarrow" },
    ])
    return env.python
  }

  export async function run(options: { python?: string; keep?: boolean } = {}): Promise<Result> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-engine-smoke-"))
    const engine = path.join(root, "engine_v2")
    const out = path.join(root, "out")
    try {
      await materializeEngine(engine)
      await fs.writeFile(path.join(root, "ohlcv.csv"), `${CSV}\n`)
      await fs.writeFile(path.join(root, "config.json"), `${CONFIG}\n`)
      await fs.writeFile(path.join(root, "strategy.py"), STRATEGY)

      const pythonCmd = await python(options)
      const execution = await Process.run(
        [
          pythonCmd,
          "-m",
          "engine_v2.cli",
          "--csv",
          "ohlcv.csv",
          "--config",
          "config.json",
          "--interval",
          "1d",
          "--capital",
          "10000",
          "--out",
          "out",
          "--strategy",
          "strategy.py",
          "--seed",
          "7",
        ],
        { cwd: root, env: { PYTHONPATH: root }, nothrow: true, timeout: 120_000 },
      )
      if (execution.code !== 0) {
        throw new Error(`packaged engine smoke failed: ${execution.stderr.toString().trim() || "unknown Python error"}`)
      }

      const resultsBytes = await fs.readFile(path.join(out, "results.json"))
      const tradesBytes = await fs.readFile(path.join(out, "trades.csv"))
      const results = JSON.parse(resultsBytes.toString()) as {
        profile_identity?: { data_hash?: string | null }
        run_metadata?: { data_hash?: string | null }
      }
      const processedDataSha256 = results.profile_identity?.data_hash ?? results.run_metadata?.data_hash
      if (!processedDataSha256 || !/^[a-f0-9]{64}$/.test(processedDataSha256)) {
        throw new Error("engine smoke results did not contain a valid processed data hash")
      }

      const [version, packages] = await Promise.all([
        Process.run([pythonCmd, "--version"]),
        Process.run([
          pythonCmd,
          "-c",
          "import importlib.metadata as m; print('\\n'.join(sorted(f'{d.metadata[\"Name\"]}=={d.version}' for d in m.distributions())))",
        ]),
      ])
      const packageLines = packages.stdout
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()

      return {
        engineTreeSha256: await treeHash(engine),
        rawDataSha256: sha256(`${CSV}\n`),
        processedDataSha256,
        resultSha256: sha256(resultsBytes),
        tradesSha256: sha256(tradesBytes),
        pythonVersion: (version.stdout.toString() || version.stderr.toString()).trim(),
        installedPackagesSha256: sha256(`${packageLines.join("\n")}\n`),
      }
    } finally {
      if (!options.keep) await fs.rm(root, { recursive: true, force: true })
    }
  }
}
