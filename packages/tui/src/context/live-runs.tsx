import { createStore } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
// Type-only: erased at compile time, so the runner implementation never loads
// in the TUI render process. The live runs themselves are owned by the daemon.
import type { LiveRunner } from "@/live/runner"

export type Run = LiveRunner.Run
export type StartParams = LiveRunner.StartParams

function responseErrorMessage(status: number, text: string): string {
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return `Live request failed (${status}): ${parsed.message}`
      }
    } catch {
      // Fall back to the raw response body below.
    }
    return `Live request failed (${status}): ${text}`
  }
  return `Live request failed (${status})`
}

/**
 * Live runs are owned by the long-lived Finny daemon, not the TUI. This context
 * is a thin client over the daemon's HTTP API (`/live/*`) plus its
 * `/global/event` SSE stream, exposing the same shape the TUI used when the
 * runner lived in-process — so closing the TUI no longer stops trading.
 */
export const { use: useLiveRuns, provider: LiveRunsProvider } = createSimpleContext<
  {
    runs(): Run[]
    get(id: string): Run | undefined
    start(params: StartParams): Promise<Run>
    stop(id: string): Promise<void>
    remove(id: string): Promise<void>
    /** True while connected to the daemon's event stream. */
    connected(): boolean
  },
  {
    /** Daemon base URL (from Daemon.ensure()). When absent, the context is inert. */
    url?: string
    headers?: RequestInit["headers"]
    directory?: string
  }
>({
  name: "LiveRuns",
  init: (props) => {
    const [store, setStore] = createStore<{ runs: Run[]; connected: boolean }>({ runs: [], connected: false })
    const dirKey = props.directory ?? "global"
    const abort = new AbortController()

    function headers(): Record<string, string> {
      const h: Record<string, string> = {}
      if (props.headers) Object.assign(h, props.headers as Record<string, string>)
      if (props.directory) h["x-opencode-directory"] = props.directory
      return h
    }

    async function api<T>(path: string, init?: RequestInit): Promise<T> {
      if (!props.url) throw new Error("Live daemon is not connected")
      const res = await fetch(new URL(path, props.url), {
        ...init,
        signal: init?.signal ?? abort.signal,
        headers: { "content-type": "application/json", ...headers(), ...(init?.headers as Record<string, string>) },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(responseErrorMessage(res.status, text))
      }
      return (await res.json()) as T
    }

    async function reconcile() {
      setStore("runs", await api<Run[]>("/live"))
    }

    // The daemon publishes one `live.runs` event per directory carrying that
    // directory's full run list — mirror it straight into the store.
    function handleEvent(event: GlobalEvent) {
      const payload = (event as { payload?: { type?: string; properties?: { runs?: Run[] } } }).payload
      if (!payload || payload.type !== "live.runs") return
      if ((event as { directory?: string }).directory !== dirKey) return
      setStore("runs", payload.properties?.runs ?? [])
    }

    function startSSE() {
      if (!props.url) return
      const sdk = createOpencodeClient({
        baseUrl: props.url,
        directory: props.directory,
        headers: props.headers,
        signal: abort.signal,
      })
      void (async () => {
        let attempt = 0
        while (!abort.signal.aborted) {
          try {
            const events = await sdk.global.event({ signal: abort.signal, sseMaxRetryAttempts: 0 })
            setStore("connected", true)
            attempt = 0
            await reconcile() // seed / re-sync after the stream is open to catch pre-connect state
            for await (const event of events.stream) {
              if (abort.signal.aborted) break
              handleEvent(event)
            }
          } catch {
            // fall through to backoff
          }
          setStore("connected", false)
          if (abort.signal.aborted) break
          attempt += 1
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30000)))
        }
      })().catch(() => {})
    }

    onMount(() => startSSE())
    onCleanup(() => abort.abort())

    function upsert(run: Run) {
      setStore("runs", (rs) => {
        const i = rs.findIndex((r) => r.id === run.id)
        if (i === -1) return [...rs, run]
        const next = rs.slice()
        next[i] = run
        return next
      })
    }

    return {
      runs() {
        return store.runs
      },
      get(id: string) {
        return store.runs.find((r) => r.id === id)
      },
      async start(params: StartParams) {
        const run = await api<Run>("/live/start", {
          method: "POST",
          body: JSON.stringify({
            algorithm: params.algorithm,
            symbol: params.symbol,
            interval: params.interval,
            accountProviderID: params.accountProviderID,
            brokerKind: params.brokerKind,
          }),
        })
        upsert(run) // optimistic; the SSE stream keeps it fresh
        return run
      },
      async stop(id: string) {
        await api<boolean>(`/live/${encodeURIComponent(id)}/stop`, { method: "POST" })
      },
      async remove(id: string) {
        await api<boolean>(`/live/${encodeURIComponent(id)}`, { method: "DELETE" })
        setStore("runs", (rs) => rs.filter((r) => r.id !== id))
      },
      connected() {
        return store.connected
      },
    }
  },
})
