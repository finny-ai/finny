import "@/instrumentation"
import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Log } from "@/util/log"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Analytics } from "@/analytics/tracker"
import { UsageTracker } from "@/analytics/usage"
import { TelemetryLifecycle } from "@/analytics/lifecycle"

Heap.start()

const logReady = Log.init({ print: false, dev: true })

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

// The default (local) TUI talks to this worker via the "fetch" RPC, which uses
// Server.Default() and NEVER calls Server.listen() - the only place chat
// telemetry (SessionSync) is normally started. Start it here so interactive TUI
// sessions emit telemetry. Idempotent with the listen() path used by external/
// headless mode (SessionSync.start no-ops once started).
void TelemetryLifecycle.refreshAndStart("tui").catch(() => {})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    await logReady
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  // Re-run telemetry init once the TUI signals readiness. Idempotent.
  async refreshTelemetry() {
    await TelemetryLifecycle.refreshAndStart("tui")
  },
  async shutdown() {
    // Flush buffered telemetry before tearing down. The TUI quits by calling
    // this RPC and then worker.terminate(), which kills the thread before
    // `beforeExit`/signal drains can run - so without this, the 5s-debounced
    // buffer is lost on every normal quit.
    await UsageTracker.stop().catch(() => {})
    await Analytics.drain(1500).catch(() => {})
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)
