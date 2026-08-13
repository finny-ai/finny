import { createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import { SegmentedControl } from "../ui/segmented-control"

type LeanStatus = {
  enabled: boolean
  effective: boolean
  certified: boolean
  source: "env" | "setting" | "default"
  readiness: { ready: boolean; reasons: string[] }
  engineImage: {
    pinnedCommit: string
    pinnedDigest: string
    daemonUp: boolean
    imagePresent: boolean
    imageRef: string
  }
}

type EngineActionResult = {
  ok: boolean
  message: string
  pinnedCommit: string
  pinnedDigest: string
  daemonUp: boolean
  imagePresent: boolean
  imageRef: string
  localDigest?: string
  requiresRestart?: boolean
  newCommit?: string
}

/**
 * Native LEAN engine settings: enable/disable persisted in Finny (no env
 * vars needed) plus a readiness check that explains what is still missing
 * (Docker, pinned image, certificate, platform).
 */
export function SettingsPanelLean() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()

  const [status, setStatus] = createSignal<LeanStatus>({
    enabled: false,
    effective: false,
    certified: false,
    source: "default",
    readiness: { ready: false, reasons: [] },
    engineImage: {
      pinnedCommit: "",
      pinnedDigest: "",
      daemonUp: false,
      imagePresent: false,
      imageRef: "",
    },
  })
  const [busy, setBusy] = createSignal(false)
  const [engineBusy, setEngineBusy] = createSignal(false)
  const [engineDetail, setEngineDetail] = createSignal<string | null>(null)

  const request = async (path: string, init?: RequestInit) => {
    const url = new URL(path, sdk.url)
    const headers = new Headers(sdk.headers)
    headers.set("accept", "application/json")
    if (init?.body) headers.set("content-type", "application/json")
    return sdk.fetch(url, { ...init, headers })
  }

  const refresh = async () => {
    try {
      const response = await request("/lean/status")
      if (!response.ok) throw new Error(`status ${response.status}`)
      setStatus((await response.json()) as LeanStatus)
    } catch (cause) {
      toast.show({ message: `Could not read LEAN status: ${String(cause)}`, variant: "error", duration: 5000 })
    }
  }

  onMount(() => void refresh())

  const setEnabled = async (enabled: boolean) => {
    if (busy()) return
    setBusy(true)
    try {
      const response = await request("/lean/enabled", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      setStatus((await response.json()) as LeanStatus)
      toast.show({
        message: enabled ? "LEAN engine enabled" : "LEAN engine disabled",
        variant: "success",
        duration: 3000,
      })
    } catch (e: any) {
      toast.show({ message: `Could not switch LEAN engine: ${e?.message ?? "unknown error"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const engineAction = async (path: string, label: string) => {
    if (engineBusy()) return
    setEngineBusy(true)
    setEngineDetail(null)
    try {
      const response = await request(path, { method: "POST", body: JSON.stringify({}) })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const result = (await response.json()) as EngineActionResult
      setEngineDetail(result.message)
      setStatus((await (await request("/lean/status")).json()) as LeanStatus)
      toast.show({
        message: result.ok ? `${label}: ${result.message}` : `${label} failed: ${result.message}`,
        variant: result.ok ? "success" : "error",
        duration: 8000,
      })
    } catch (e: any) {
      toast.show({ message: `${label} error: ${e?.message ?? "unknown error"}`, variant: "error", duration: 5000 })
    } finally {
      setEngineBusy(false)
    }
  }

  const Action = (props: { label: string; onClick: () => void }) => (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundElement}
      onMouseUp={props.onClick}
    >
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
    </box>
  )

  return (
    <Card title=" LEAN engine " flexGrow={1}>
      <box flexDirection="column" gap={2} flexGrow={1} minHeight={0}>
        <box flexDirection="column" gap={1} flexShrink={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Backtest runtime
          </text>
          <text fg={theme.textMuted}>
            When enabled, strategies saved with the LEAN runtime backtest on the pinned QuantConnect LEAN engine
            instead of Crucible. No environment variables needed — the choice is stored in Finny.
          </text>
          <SegmentedControl<"enabled" | "disabled">
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            value={status().enabled ? "enabled" : "disabled"}
            onChange={(value) => void setEnabled(value === "enabled")}
            gap={4}
          />
          <Show when={status().source === "env"}>
            <text fg={theme.warning}>Forced by environment variables (FINNY_LEAN_ENABLED) — the setting is overridden.</text>
          </Show>
        </box>

        <box flexDirection="column" gap={1} flexShrink={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Readiness
          </text>
          <Show
            when={status().readiness.ready}
            fallback={
              <box flexDirection="column" gap={1}>
                <text fg={theme.warning}>LEAN is not ready to run backtests:</text>
                <For each={status().readiness.reasons}>
                  {(reason) => (
                    <text fg={theme.textMuted}>
                      {"  • "}
                      {reason}
                    </text>
                  )}
                </For>
              </box>
            }
          >
            <text fg={theme.success}>LEAN runtime is ready (flag, certificate, platform, pinned image).</text>
          </Show>
          <box flexDirection="row" gap={2}>
            <Action label="Re-check readiness" onClick={() => void refresh()} />
          </box>
        </box>

        <box flexDirection="column" gap={1} flexShrink={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Engine image
          </text>
          <Show when={status().engineImage.pinnedCommit}>
            <text fg={theme.textMuted}>
              Pinned: {status().engineImage.pinnedCommit.slice(0, 12)} · {status().engineImage.imageRef}
            </text>
            <text fg={theme.textMuted}>Digest: {status().engineImage.pinnedDigest.slice(0, 19)}…</text>
            <text fg={status().engineImage.daemonUp ? theme.text : theme.warning}>
              Docker daemon: {status().engineImage.daemonUp ? "running" : "not running"}
            </text>
            <text fg={status().engineImage.imagePresent ? theme.success : theme.warning}>
              Pinned image: {status().engineImage.imagePresent ? "present locally" : "not present — pull it"}
            </text>
          </Show>
          <Show when={!status().engineImage.daemonUp}>
            <text fg={theme.warning}>Start Colima or Docker Desktop before pulling or building the engine image.</text>
          </Show>
          <box flexDirection="row" gap={2}>
            <Action label={engineBusy() ? "Working…" : "Pull engine image"} onClick={() => void engineAction("/lean/engine/pull", "Pull")} />
            <Action label={engineBusy() ? "Working…" : "Build from template"} onClick={() => void engineAction("/lean/engine/build", "Build")} />
            <Action label={engineBusy() ? "Working…" : "Update to latest"} onClick={() => void engineAction("/lean/engine/update", "Update")} />
          </box>
          <Show when={engineDetail()}>
            <text fg={theme.textMuted}>{engineDetail()}</text>
          </Show>
          <Show when={engineBusy()}>
            <text fg={theme.warning}>
              Pull/build can take several minutes for a 20GB image; the panel stays responsive, do not close the app.
            </text>
          </Show>
        </box>
      </box>
    </Card>
  )
}
