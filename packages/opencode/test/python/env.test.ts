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

  test("package-set paths are stable across requirement order", () => {
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    const first = [
      { spec: "pandas", importCheck: "pandas" },
      { spec: "numpy", importCheck: "numpy" },
    ]
    const second = [...first].reverse()
    expect(Python.sharedEnvDir(first)).toBe(Python.sharedEnvDir(second))
    expect(Python.sharedEnvDir(first)).toStartWith(path.join(sandbox, "custom-finny-home", "python-envs"))
  })

  test("refuses to modify unknown data at a shared package-set path", async () => {
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const envDir = Python.sharedEnvDir(packages)
    await fs.mkdir(envDir, { recursive: true })
    await fs.writeFile(path.join(envDir, "user-data.txt"), "keep me\n")

    const error = await Python.ensurePythonEnv(packages).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("Refusing to modify unrecognized data")
    expect(await fs.readFile(path.join(envDir, "user-data.txt"), "utf8")).toBe("keep me\n")
  })

  test("preserves and replaces a recognized interrupted shared build", async () => {
    const hasPython = await Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    if (!hasPython) return
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const envDir = Python.sharedEnvDir(packages)
    await fs.mkdir(envDir, { recursive: true })
    await fs.writeFile(path.join(envDir, "partial.txt"), "preserve\n")
    await fs.writeFile(
      Python.sharedEnvBuildMarkerPath(envDir),
      JSON.stringify({ envDir, packageSetHash: Python.packageSetHash(packages), pid: 999999 }) + "\n",
    )

    const env = await Python.ensurePythonEnv(packages)
    const siblings = await fs.readdir(Python.sharedEnvsRoot())
    const quarantine = siblings.find((name) => name.startsWith(`${path.basename(envDir)}.incomplete-`))

    expect(env.envDir).toBe(envDir)
    expect(quarantine).toBeTruthy()
    expect(await fs.readFile(path.join(Python.sharedEnvsRoot(), quarantine!, "partial.txt"), "utf8")).toBe("preserve\n")
    expect(await Bun.file(Python.sharedEnvBuildMarkerPath(envDir)).exists()).toBe(false)
  }, 60_000)

  test("refuses to reset an environment leased by another Finny owner", async () => {
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    const packages = [{ spec: "pytz", importCheck: "pytz" }]
    const envDir = Python.sharedEnvDir(packages)
    const python = Python.pythonBinForEnvDir(envDir)
    await fs.mkdir(path.dirname(python), { recursive: true })
    await fs.writeFile(python, "")
    await fs.writeFile(
      Python.envMarkerPath(envDir),
      JSON.stringify({
        installer: "uv",
        python,
        packages,
        verifiedAt: "2026-01-01T00:00:00.000Z",
      }) + "\n",
    )
    await fs.mkdir(path.join(envDir, ".finny-env-leases"))
    await fs.writeFile(path.join(envDir, ".finny-env-leases", String(process.pid)), "")

    const error = await Python.resetSharedPythonEnv(packages).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("active in another Finny process")
    expect(await fs.stat(envDir)).toBeTruthy()
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
