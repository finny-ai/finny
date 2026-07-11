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
    expect(
      await fs.readFile(path.join(sandbox, "home", "algorithms", "algo-home-test", "v01", "reasoning.md"), "utf8"),
    ).toBe("")

    for (const dir of ["stock", "etf", "future", "option", "crypto", "sec", "news", "sentiment"]) {
      const stat = await fs.stat(path.join(sandbox, "home", "algorithms", "algo-home-test", "data", dir))
      expect(stat.isDirectory()).toBe(true)
    }
  })

  test("publishes complete version snapshots and append-only decisions", async () => {
    const common = {
      algorithmId: "algo-version-docs",
      userId: "local",
      name: "spy-version-docs",
      code: "class Strategy:\n    pass\n",
      language: "python",
      status: "draft",
      time_created: 1,
    }
    const first = await LocalAlgorithmStore.insertVersion({
      ...common,
      config: '{"period":10}\n',
      mission: "mission-v1\n",
      prefs: "prefs-v1\n",
      decisions: "decision-v1\n",
      riskContract: '{"max_drawdown_pct":10}\n',
      docsMode: "replace",
      time_updated: 2,
    })
    const second = await LocalAlgorithmStore.insertVersion({
      ...common,
      config: '{"period":20}\n',
      mission: "mission-v2\n",
      prefs: "prefs-v2\n",
      decisions: "decision-v2\n",
      riskContract: '{"max_drawdown_pct":8}\n',
      docsMode: "replace",
      time_updated: 3,
    })

    expect([first.version, second.version]).toEqual([1, 2])
    const root = path.join(algorithmsDir(), common.algorithmId)
    expect(await fs.readFile(path.join(root, "CURRENT"), "utf8")).toBe("v02")
    for (const file of ["strategy.py", "config.json", "reasoning.md", "mission.md", "prefs.md", "decisions.md", "risk.json"]) {
      expect((await fs.stat(path.join(root, "v02", file))).isFile()).toBe(true)
    }
    expect(await fs.readFile(path.join(root, "v01", "config.json"), "utf8")).toBe('{"period":10}\n')
    expect(await fs.readFile(path.join(root, "v01", "mission.md"), "utf8")).toBe("mission-v1\n")
    expect(await fs.readFile(path.join(root, "v02", "mission.md"), "utf8")).toBe("mission-v2\n")
    expect(await fs.readFile(path.join(root, "v02", "decisions.md"), "utf8")).toBe(
      "decision-v1\n\ndecision-v2\n",
    )
    for (const file of ["mission.md", "prefs.md", "decisions.md", "risk.json"]) {
      expect(await fs.readFile(path.join(root, file), "utf8")).toBe(
        await fs.readFile(path.join(root, "v02", file), "utf8"),
      )
    }
    expect((await fs.readdir(root)).some((entry) => entry.startsWith(".tmp-v"))).toBe(false)
  })

  test("serializes concurrent saves and treats reasoning changes as new versions", async () => {
    const common = {
      algorithmId: "algo-concurrent-versions",
      userId: "local",
      name: "spy-concurrent-versions",
      code: "class Strategy:\n    pass\n",
      language: "python",
      status: "draft",
      time_created: 1,
    }
    await LocalAlgorithmStore.insertVersion({
      ...common,
      config: '{"period":10}\n',
      reasoning: "reason-one\n",
      mission: "mission\n",
      prefs: "prefs\n",
      decisions: "decision\n",
      riskContract: "{}\n",
      docsMode: "replace",
      time_updated: 2,
    })
    const reasoningOnly = await LocalAlgorithmStore.insertVersion({
      ...common,
      config: '{"period":10}\n',
      reasoning: "reason-two\n",
      docsMode: "inherit",
      time_updated: 3,
    })
    expect(reasoningOnly.version).toBe(2)

    const concurrent = await Promise.all([
      LocalAlgorithmStore.insertVersion({
        ...common,
        config: '{"period":20}\n',
        reasoning: "reason-three\n",
        docsMode: "inherit",
        time_updated: 4,
      }),
      LocalAlgorithmStore.insertVersion({
        ...common,
        config: '{"period":30}\n',
        reasoning: "reason-four\n",
        docsMode: "inherit",
        time_updated: 5,
      }),
    ])
    expect(concurrent.map((row) => row.version).sort()).toEqual([3, 4])
    expect(
      (await LocalAlgorithmStore.listVersions(common.algorithmId))
        .map((row) => row.version)
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3, 4])
    expect((await LocalAlgorithmStore.getById(common.algorithmId))?.version).toBe(4)
    const root = path.join(algorithmsDir(), common.algorithmId)
    expect(await fs.readFile(path.join(root, "CURRENT"), "utf8")).toBe("v04")
    expect((await fs.readdir(root)).some((entry) => entry === ".version.lock" || entry.startsWith(".tmp-v"))).toBe(false)
  })
})
