import { ProcessSignal } from "@opencode-ai/core/process-signal"
import "../../src/analytics/tracker"

await ProcessSignal.withOwnership("SIGINT", async (interrupted) => {
  process.kill(process.env.FINNY_SIGNAL_PROCESS_GROUP === "1" ? 0 : process.pid, "SIGINT")
  await Bun.sleep(25)
  process.stdout.write(`${JSON.stringify({ alive: true, interrupted: interrupted() })}\n`)
})
