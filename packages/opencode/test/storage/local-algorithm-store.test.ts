import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LocalAlgorithmStore, algorithmsDir } from "../../src/storage/local/algorithm-store"

let sandbox: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-local-store-"))
  process.env.FINNY_HOME = path.join(sandbox, "home")
})

afterEach(async () => {
  process.env = savedEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("LocalAlgorithmStore", () => {
  test("writes saved algorithms under FINNY_HOME", async () => {
    const row = await LocalAlgorithmStore.insertVersion({
      algorithmId: "algo-home-test",
      userId: "local",
      name: "spy-home-test",
      code: "class Strategy:\n    pass\n",
      language: "python",
      status: "draft",
      time_created: 1,
      time_updated: 2,
    })

    expect(row.version).toBe(1)
    expect(algorithmsDir()).toBe(path.join(sandbox, "home", "algorithms"))
    expect(
      await fs.readFile(path.join(sandbox, "home", "algorithms", "algo-home-test", "v01", "strategy.py"), "utf8"),
    ).toBe("class Strategy:\n    pass\n")
  })
})
