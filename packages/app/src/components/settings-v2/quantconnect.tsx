import { Component, createSignal, Show, onMount } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { useServer } from "@/context/server"

type QcStatus = {
  connected: boolean
  fixture?: boolean
  mode?: {
    mode: "fixture" | "cloud"
    configured: "fixture" | "cloud"
    source: "env" | "setting" | "default"
  }
  userId?: string
  name?: string
  error?: string
}

/**
 * QuantConnect API credentials entered natively in Finny settings.
 * The server verifies credentials against QuantConnect before storing them
 * (GET/POST/DELETE /qc/* on the instance HTTP API).
 */
export const SettingsQuantConnectV2: Component = () => {
  const server = useServer()
  const [status, setStatus] = createSignal<QcStatus | null>(null)
  const [userId, setUserId] = createSignal("")
  const [apiToken, setApiToken] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [savingMode, setSavingMode] = createSignal(false)

  const request = async (path: string, init?: RequestInit) => {
    const current = server.current
    if (!current) throw new Error("No server available")
    const url = new URL(path, current.http.url)
    const headers = new Headers(init?.headers)
    headers.set("accept", "application/json")
    if (current.http.password) {
      headers.set("authorization", `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`)
    }
    return fetch(url, { ...init, headers })
  }

  const refresh = async () => {
    try {
      const response = await request("/qc/status")
      setStatus((await response.json()) as QcStatus)
    } catch (cause) {
      setStatus({ connected: false, error: String(cause) })
    }
  }

  onMount(() => void refresh())

  const connect = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await request("/qc/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: userId(), apiToken: apiToken() }),
      })
      if (!response.ok) {
        setError("QuantConnect rejected these credentials. Nothing was stored.")
        return
      }
      setUserId("")
      setApiToken("")
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await request("/qc/credentials", { method: "DELETE" })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const setMode = async (mode: "fixture" | "cloud") => {
    setSavingMode(true)
    setError(undefined)
    try {
      const response = await request("/qc/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      })
      if (!response.ok) {
        setError("Could not switch QuantConnect mode.")
        return
      }
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSavingMode(false)
    }
  }

  return (
    <SettingsListV2>
      <SettingsRowV2
        title="QC track mode"
        description="Local fixture runs the QC flow against deterministic local fixtures (no account needed). QuantConnect Cloud talks to your real QC account."
      >
        <SegmentedControlV2
          value={status()?.mode?.mode ?? "cloud"}
          onChange={(value) => value && setMode(value as "fixture" | "cloud")}
          disabled={savingMode()}
          aria-label="QuantConnect track mode"
        >
          <SegmentedControlItemV2 value="cloud">QuantConnect Cloud</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="fixture">Local fixture</SegmentedControlItemV2>
        </SegmentedControlV2>
      </SettingsRowV2>

      <SettingsRowV2 title="QuantConnect API credentials" description="Used for the QC Cloud track: data pulls, cloud backtests, and execution.">
        <Show
          when={status()?.connected}
          fallback={<span class="text-xs">{status()?.error ?? "Not connected."}</span>}
        >
          <span class="text-xs">
            Connected as {status()?.name ?? status()?.userId} ({status()?.userId})
          </span>
        </Show>
      </SettingsRowV2>

      <Show when={status()?.fixture}>
        <p class="text-xs">
          Local fixture mode is active{status()?.mode?.source === "env" ? " (forced by environment variables)" : ""} —
          no QC account is used.
        </p>
      </Show>

      <SettingsRowV2 title="User id" description="QuantConnect account user id (Account -> Organizations).">
        <TextInputV2 value={userId()} onInput={(event) => setUserId(event.currentTarget.value)} placeholder="1234567" />
      </SettingsRowV2>
      <SettingsRowV2 title="API token" description="QuantConnect API token (Account -> Security -> API Access).">
        <TextInputV2
          value={apiToken()}
          onInput={(event) => setApiToken(event.currentTarget.value)}
          type="password"
          placeholder="****************"
        />
      </SettingsRowV2>

      <div class="flex items-center gap-2 pt-2">
        <ButtonV2 onClick={() => void connect()} disabled={busy() || !userId() || !apiToken()}>
          {busy() ? "Verifying…" : "Save and verify"}
        </ButtonV2>
        <Show when={status()?.connected}>
          <ButtonV2 onClick={() => void disconnect()} variant="ghost" disabled={busy()}>
            Disconnect
          </ButtonV2>
        </Show>
      </div>

      <Show when={error()}>
        <p class="text-xs">{error()}</p>
      </Show>
    </SettingsListV2>
  )
}
