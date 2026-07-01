import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { FINNY_BROKER_PY } from "../../src/backtest/broker-py"

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-native-hedge-broker-"))
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("broker order rationale compatibility", () => {
  test("keeps old buy/sell calls working and serializes reason/features when provided", async () => {
    await fs.writeFile(path.join(tempDir, "finny_broker.py"), FINNY_BROKER_PY, "utf8")
    await fs.writeFile(
      path.join(tempDir, "check.py"),
      [
        "import json",
        "from finny_broker import SimBroker",
        "broker = SimBroker(1000)",
        "old_order = broker.buy('AAPL', qty=1)",
        "new_order = broker.sell('AAPL', qty=1, reason='RSI crossed above 70', features={'rsi': 72.1})",
        "print(json.dumps({'old': old_order.to_dict(), 'new': new_order.to_dict()}))",
      ].join("\n"),
      "utf8",
    )

    const proc = Bun.spawn([process.env.PYTHON ?? "python3", "check.py"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.old.reason).toBeUndefined()
    expect(parsed.new.reason).toBe("RSI crossed above 70")
    expect(parsed.new.features).toEqual({ rsi: 72.1 })
  })
})
