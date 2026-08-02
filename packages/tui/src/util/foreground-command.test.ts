import { expect, test } from "bun:test"
import { ProcessSignal } from "@opencode-ai/core/process-signal"
import { foregroundCommandExitError, withForegroundSignalGuard } from "./foreground-command"

test("foreground command treats an observed SIGINT as cancellation even when the child exits zero", () => {
  const error = foregroundCommandExitError(0, null, true)
  expect(error?.cancelled).toBe(true)
  expect(error?.message).toBe("Interactive command cancelled")
})

test("foreground signal guard prevents gated parent shutdown on SIGINT", async () => {
  let shutdowns = 0
  const shutdown = (signal: NodeJS.Signals) => {
    if (!ProcessSignal.isOwned(signal)) shutdowns += 1
  }
  process.on("SIGINT", shutdown)

  try {
    await withForegroundSignalGuard("SIGINT", async (interrupted) => {
      expect(ProcessSignal.isOwned("SIGINT")).toBe(true)
      process.emit("SIGINT", "SIGINT")
      expect(interrupted()).toBe(true)
      expect(shutdowns).toBe(0)
    })
    expect(ProcessSignal.isOwned("SIGINT")).toBe(false)
  } finally {
    process.off("SIGINT", shutdown)
  }
})
