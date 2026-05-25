import { otelProvider, flushWithTimeout } from "../../../instrumentation"
import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { Analytics } from "@/analytics/tracker"
import { SessionSync } from "@/analytics/session-sync"
import { Scheduler } from "@/cron"

// Boot-time telemetry — fires once per worker process. Best signal that the
// user actually launched the TUI (vs. CLI subcommands that exit immediately).
// Intentionally no argv: process.argv can include positional project paths
// and --prompt text, which would leak local file paths and prompt content.
Analytics.track({
  eventType: "app",
  eventName: "tui.worker.booted",
})

// Live session/message/part mirroring to Convex. Subscribes to GlobalBus,
// buffers part updates per-message, and ships once per completed message —
// roughly 1/20th the call volume of writing every streaming frame.
// Honors the same FINNY_TELEMETRY=1 opt-in as analytics events.
SessionSync.start()

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()
Scheduler.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
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
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await Config.invalidate(true)
  },
  async shutdown() {
    Log.Default.info("worker shutting down")

    // Drain in-flight analytics writes before disposing — neither
    // beforeExit nor SIGTERM fire reliably inside Bun workers when the
    // main thread calls worker.terminate(), so we have to do it here.
    await Analytics.drain(1500).catch(() => {})
    if (otelProvider) await flushWithTimeout(otelProvider, 2_000).catch(() => {})
    Scheduler.stop()

    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
