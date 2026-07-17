import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Python } from "../../src/python/env"

let sandbox: string
let prevFinnyHome: string | undefined
let prevHarnessMode: string | undefined
let prevHarnessPythonEnv: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-python-env-"))
  prevFinnyHome = process.env.FINNY_HOME
  prevHarnessMode = process.env.FINNY_HARNESS_MODE
  prevHarnessPythonEnv = process.env.FINNY_HARNESS_PYTHON_ENV
})

afterEach(async () => {
  if (prevFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = prevFinnyHome
  if (prevHarnessMode === undefined) delete process.env.FINNY_HARNESS_MODE
  else process.env.FINNY_HARNESS_MODE = prevHarnessMode
  if (prevHarnessPythonEnv === undefined) delete process.env.FINNY_HARNESS_PYTHON_ENV
  else process.env.FINNY_HARNESS_PYTHON_ENV = prevHarnessPythonEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("managed Python env", () => {
  test("lives under FINNY_HOME", () => {
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    expect(Python.PATHS.ENV_DIR).toBe(path.join(sandbox, "custom-finny-home", "python-env"))
    expect(Python.PATHS.PY_BIN).toBe(Python.pythonBinForEnvDir(Python.PATHS.ENV_DIR))
    expect(Python.PATHS.PIP_BIN).toBe(Python.pipBinForEnvDir(Python.PATHS.ENV_DIR))
  })

  test("locked harness env accepts exact quote-style subsets but never missing or changed specs", async () => {
    const envDir = path.join(sandbox, "locked-python")
    const created = Bun.spawn(["python3", "-m", "venv", envDir], { stdout: "ignore", stderr: "ignore" })
    if ((await created.exited.catch(() => 1)) !== 0) return

    const python = Python.pythonBinForEnvDir(envDir)
    const siteProbe = Bun.spawn([python, "-c", "import site; print(site.getsitepackages()[0])"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [siteExit, siteOutput] = await Promise.all([siteProbe.exited, new Response(siteProbe.stdout).text()])
    if (siteExit !== 0) return
    const sitePackages = siteOutput.trim()
    await Promise.all(
      ["yfinance", "pandas", "requests"].map((module) =>
        fs.writeFile(path.join(sitePackages, `${module}.py`), "# locked harness test module\n"),
      ),
    )

    const markerPackages = [
      { spec: "yfinance", importCheck: "yfinance" },
      { spec: "pandas", importCheck: "pandas" },
      { spec: "requests", importCheck: "requests" },
    ]
    await fs.writeFile(
      Python.envMarkerPath(envDir),
      `${JSON.stringify({ installer: "uv", python, packages: markerPackages, verifiedAt: new Date().toISOString() })}\n`,
    )
    process.env.FINNY_HARNESS_MODE = "1"
    process.env.FINNY_HARNESS_PYTHON_ENV = envDir

    const quote = await Python.ensurePythonEnvAt(envDir, [{ spec: "yfinance", importCheck: "yfinance" }])
    expect(quote.python).toBe(python)
    const portfolio = await Python.ensurePythonEnvAt(envDir, [
      { spec: "yfinance", importCheck: "yfinance" },
      { spec: "pandas", importCheck: "pandas" },
    ])
    expect(portfolio.python).toBe(python)

    await expect(
      Python.ensurePythonEnvAt(envDir, [{ spec: "yfinance>=0.2", importCheck: "yfinance" }]),
    ).rejects.toThrow("exact requested package spec/import")
    await expect(Python.ensurePythonEnvAt(envDir, [{ spec: "numpy", importCheck: "numpy" }])).rejects.toThrow(
      "dynamic installation is disabled",
    )
  })
})
