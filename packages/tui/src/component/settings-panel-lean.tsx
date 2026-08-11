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
  })
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
      </box>
    </Card>
  )
}
