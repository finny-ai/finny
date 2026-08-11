import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Card } from "./card"
import { SegmentedControl } from "../ui/segmented-control"

type QcMode = "cloud" | "fixture"
type QcModeSource = "env" | "setting" | "default"

type QcStatus = {
  connected: boolean
  fixture?: boolean
  mode?: {
    mode: QcMode
    configured: QcMode
    source: QcModeSource
  }
  userId?: string
  name?: string
  error?: string
}

/**
 * QuantConnect control-plane settings: track mode (local fixture vs
 * QuantConnect Cloud) and API credentials. Talks to the instance HTTP API
 * (/qc/status, /qc/mode, /qc/credentials).
 */
export function SettingsPanelQuantConnect() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()

  const [status, setStatus] = createSignal<QcStatus>({ connected: false })
  const [busy, setBusy] = createSignal(false)

  const request = async (path: string, init?: RequestInit) => {
    const url = new URL(path, sdk.url)
    const headers = new Headers(sdk.headers)
    headers.set("accept", "application/json")
    if (init?.body) headers.set("content-type", "application/json")
    return sdk.fetch(url, { ...init, headers })
  }

  const refresh = async () => {
    try {
      const response = await request("/qc/status")
      if (!response.ok) throw new Error(`status ${response.status}`)
      setStatus((await response.json()) as QcStatus)
    } catch (cause) {
      setStatus({ connected: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  onMount(() => void refresh())

  const setMode = async (mode: QcMode) => {
    if (busy()) return
    setBusy(true)
    try {
      const response = await request("/qc/mode", {
        method: "POST",
        body: JSON.stringify({ mode }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      await refresh()
      toast.show({
        message: mode === "fixture" ? "QC track switched to Local fixture" : "QC track switched to QuantConnect Cloud",
        variant: "success",
        duration: 3000,
      })
    } catch (e: any) {
      toast.show({ message: `Could not switch QC mode: ${e?.message ?? "unknown error"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    const userId = await DialogPrompt.show(dialog, "QuantConnect user id", {
      placeholder: "Account -> Organizations -> your id",
    })
    if (userId === null) return
    const apiToken = await DialogPrompt.show(dialog, "QuantConnect API token", {
      placeholder: "Account -> Security -> API Access",
    })
    if (apiToken === null) return
    setBusy(true)
    try {
      const response = await request("/qc/credentials", {
        method: "POST",
        body: JSON.stringify({ userId: userId.trim(), apiToken: apiToken.trim() }),
      })
      if (!response.ok) {
        toast.show({
          message: "QuantConnect rejected these credentials. Nothing was stored.",
          variant: "error",
          duration: 5000,
        })
        return
      }
      await refresh()
      toast.show({ message: "QuantConnect credentials connected", variant: "success", duration: 3000 })
    } catch (e: any) {
      toast.show({ message: `Failed to connect: ${e?.message ?? "unknown error"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await request("/qc/credentials", { method: "DELETE" })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const Action = (props: { label: string; disabled?: boolean; primary?: boolean; onClick: () => void }) => (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.primary && !props.disabled ? theme.backgroundElement : undefined}
      onMouseUp={() => {
        if (!props.disabled) props.onClick()
      }}
    >
      <text
        fg={props.disabled ? theme.textMuted : props.primary ? theme.primary : theme.textMuted}
        attributes={TextAttributes.BOLD}
      >
        {props.label}
      </text>
    </box>
  )

  const mode = () => status()?.mode?.mode ?? "cloud"
  const source = () => status()?.mode?.source

  return (
    <Card title=" QuantConnect " flexGrow={1}>
      <box flexDirection="column" gap={2} flexGrow={1} minHeight={0}>
        <box flexDirection="column" gap={1} flexShrink={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            QC track mode
          </text>
          <text fg={theme.textMuted}>
            Local fixture runs the QC flow against deterministic fixtures (no account needed). QuantConnect Cloud
            talks to your real QC account.
          </text>
          <SegmentedControl<QcMode>
            options={[
              { value: "cloud", label: "QuantConnect Cloud" },
              { value: "fixture", label: "Local fixture" },
            ]}
            value={mode()}
            onChange={(value) => void setMode(value)}
            gap={4}
          />
          <Show when={source() === "env"}>
            <text fg={theme.warning}>Mode is forced by environment variables (QC_FIXTURE / FINNY_QC_FIXTURE).</text>
          </Show>
        </box>

        <box flexDirection="column" gap={1} flexShrink={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Connection
          </text>
          <Show
            when={status()?.connected}
            fallback={<text fg={theme.textMuted}>{status()?.error ?? "Not connected."}</text>}
          >
            <text fg={theme.success}>
              Connected as {status()?.name ?? status()?.userId} ({status()?.userId})
            </text>
          </Show>
          <Show when={mode() === "fixture"}>
            <text fg={theme.textMuted}>
              Local fixture mode is active — no QuantConnect account is used. Link a fixture project from Algorithms
              and deploy to the local paper ledger.
            </text>
          </Show>
        </box>

        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show
            when={status()?.connected}
            fallback={
              <Action label={busy() ? "Working..." : "Connect credentials"} primary disabled={busy()} onClick={() => void connect()} />
            }
          >
            <Action label="Disconnect" disabled={busy()} onClick={() => void disconnect()} />
          </Show>
        </box>
      </box>
    </Card>
  )
}
