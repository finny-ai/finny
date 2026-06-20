import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Python } from "../../src/python/env"

let sandbox: string
let prevFinnyHome: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-python-env-"))
  prevFinnyHome = process.env.FINNY_HOME
})

afterEach(async () => {
  if (prevFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = prevFinnyHome
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("managed Python env", () => {
  test("lives under FINNY_HOME", () => {
    process.env.FINNY_HOME = path.join(sandbox, "custom-finny-home")
    expect(Python.PATHS.ENV_DIR).toBe(path.join(sandbox, "custom-finny-home", "python-env"))
    expect(Python.PATHS.PY_BIN).toBe(Python.pythonBinForEnvDir(Python.PATHS.ENV_DIR))
    expect(Python.PATHS.PIP_BIN).toBe(Python.pipBinForEnvDir(Python.PATHS.ENV_DIR))
  })
})
