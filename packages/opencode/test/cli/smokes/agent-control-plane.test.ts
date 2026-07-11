import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("agent-friendly CLI control plane (smoke)", () => {
  cliIt.live(
    "session/inbox/commands flows work in an isolated harness",
    ({ opencode }) =>
      Effect.gen(function* () {
        const created = yield* opencode.spawn(["session", "create", "--title", "agent cli smoke"])
        opencode.expectExit(created, 0, "session create")
        const session = JSON.parse(created.stdout) as { id: string; title: string }
        expect(session.title).toBe("agent cli smoke")
        expect(session.id).toMatch(/^ses_/)

        const listed = yield* opencode.spawn(["session", "list"])
        opencode.expectExit(listed, 0, "session list")

        const finnyListed = yield* opencode.spawn(["session", "list", "--format", "json", "--mode", "finny"])
        opencode.expectExit(finnyListed, 0, "session list --mode finny")
        expect(finnyListed.stdout === "" || finnyListed.stdout.trim().startsWith("[")).toBe(true)

        const tasks = yield* opencode.spawn(["task", "list", session.id])
        opencode.expectExit(tasks, 0, "task list")
        expect(JSON.parse(tasks.stdout)).toEqual([])

        const modes = yield* opencode.spawn(["session", "modes"])
        opencode.expectExit(modes, 0, "session modes")
        const modeRows = JSON.parse(modes.stdout) as Array<{ name?: string }>
        expect(modeRows.some((row) => row.name === "build")).toBe(true)

        const inbox = yield* opencode.spawn(["inbox", "list"])
        opencode.expectExit(inbox, 0, "inbox list")
        const inboxPayload = JSON.parse(inbox.stdout) as { questions: unknown[]; permissions: unknown[] }
        expect(Array.isArray(inboxPayload.questions)).toBe(true)
        expect(Array.isArray(inboxPayload.permissions)).toBe(true)

        const commands = yield* opencode.spawn(["commands"])
        opencode.expectExit(commands, 0, "commands")
        const commandRows = JSON.parse(commands.stdout) as Array<{ name?: string }>
        expect(commandRows.some((row) => row.name === "init")).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "algo/backtest resource commands work in an isolated harness",
    ({ opencode }) =>
      Effect.gen(function* () {
        const strategyV1 = [
          "class Strategy:",
          "    def initialize(self, context):",
          "        pass",
          "",
          "    def on_bar(self, context, bar):",
          "        return None",
        ].join("\n")
        const strategyV2 = [
          "class Strategy:",
          "    def initialize(self, context):",
          "        self.version = 2",
          "",
          "    def on_bar(self, context, bar):",
          "        return None",
        ].join("\n")

        const added = yield* opencode.spawn(["algo", "add", "--name", "agent-cli-smoke", "--code", strategyV1])
        opencode.expectExit(added, 0, "algo add v1")
        const savedV1 = JSON.parse(added.stdout) as { saved: { algorithmId: string; name: string; version: number } }
        expect(savedV1.saved.name).toBe("agent-cli-smoke")
        expect(savedV1.saved.version).toBe(1)

        const addedV2 = yield* opencode.spawn([
          "algo",
          "add",
          "--name",
          "agent-cli-smoke",
          "--code",
          strategyV2,
          "--save-mode",
          "version",
          "--docs-mode",
          "inherit",
        ])
        opencode.expectExit(addedV2, 0, "algo add v2")
        const savedV2 = JSON.parse(addedV2.stdout) as { saved: { algorithmId: string; name: string; version: number } }
        expect(savedV2.saved.algorithmId).toBe(savedV1.saved.algorithmId)
        expect(savedV2.saved.version).toBe(2)

        const latestOnly = yield* opencode.spawn(["algo", "list"])
        opencode.expectExit(latestOnly, 0, "algo list")
        const latestRows = JSON.parse(latestOnly.stdout) as Array<{ name?: string; version?: number }>
        const latestMatch = latestRows.filter((row) => row.name === "agent-cli-smoke")
        expect(latestMatch).toHaveLength(1)
        expect(latestMatch[0]?.version).toBe(2)

        const listed = yield* opencode.spawn(["algo", "list", "--all-versions"])
        opencode.expectExit(listed, 0, "algo list --all-versions")
        const listedRows = JSON.parse(listed.stdout) as Array<{ name?: string; version?: number }>
        const versionsForAlgo = listedRows.filter((row) => row.name === "agent-cli-smoke").map((row) => row.version)
        expect(versionsForAlgo).toEqual([2, 1])

        const shown = yield* opencode.spawn(["algo", "show", "agent-cli-smoke"])
        opencode.expectExit(shown, 0, "algo show")
        expect(JSON.parse(shown.stdout).algorithmId).toBe(savedV1.saved.algorithmId)

        const versions = yield* opencode.spawn(["algo", "versions", "agent-cli-smoke"])
        opencode.expectExit(versions, 0, "algo versions")
        expect((JSON.parse(versions.stdout) as Array<unknown>).length).toBe(2)

        const validated = yield* opencode.spawn(["algo", "validate", "agent-cli-smoke"])
        opencode.expectExit(validated, 0, "algo validate")
        const validation = JSON.parse(validated.stdout) as { algorithm: { name: string } }
        expect(validation.algorithm.name).toBe("agent-cli-smoke")

        const backtests = yield* opencode.spawn(["backtest", "list", "--limit", "5"])
        opencode.expectExit(backtests, 0, "backtest list")
        expect(Array.isArray(JSON.parse(backtests.stdout))).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "backtest list treats unresolved ids as ids",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const algorithmId = "123e4567-e89b-12d3-a456-426614174000"
        const runId = "orphaned-run"
        const manifestDir = path.join(home, ".local", "share", "finny", "backtests", "orphaned-algo", runId)
        yield* Effect.promise(() => fs.mkdir(manifestDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(manifestDir, "manifest.json"),
            JSON.stringify(
              {
                id: runId,
                source: "run",
                algorithmId,
                algorithmName: "orphaned-algo",
                algorithmVersion: 4,
                symbol: "BTC/USD",
                params: { duration: "1m", interval: "1d", capital: "10000" },
                assumptions: { feeBps: 7.5, slippageBps: 1, fillModel: "next_open" },
                results: {
                  totalReturn: 0.12,
                  maxDrawdown: 0.04,
                  annualizedVolatility: 0.2,
                  sharpeRatio: 1.3,
                  endingEquity: 11200,
                  totalTrades: 8,
                  winRate: 0.5,
                  profitFactor: null,
                  productLabel: "Legacy backtest",
                  runKind: "legacy",
                },
                benchmark: null,
                alpha: null,
                artifacts: { equityCurve: null, trades: null, sourceArtifacts: null },
                timestamp: 1_720_000_000_000,
              },
              null,
              2,
            ),
          ),
        )

        const filtered = yield* opencode.spawn(["backtest", "list", "--algorithm", algorithmId])
        opencode.expectExit(filtered, 0, "backtest list --algorithm <id>")
        const runs = JSON.parse(filtered.stdout) as Array<{ id?: string; algorithmId?: string }>
        expect(runs).toHaveLength(1)
        expect(runs[0]?.id).toBe(runId)
        expect(runs[0]?.algorithmId).toBe(algorithmId)
      }),
    120_000,
  )
})
