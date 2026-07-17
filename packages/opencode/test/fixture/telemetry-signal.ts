import "../../src/instrumentation"

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`)
setInterval(() => {}, 1_000)
