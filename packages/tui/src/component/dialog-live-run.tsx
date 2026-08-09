import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useLiveRuns, type Run } from "../context/live-runs"
import { ModeBadge } from "./mode-badge"

function formatCurrency(value?: number): string {
  if (value === undefined || value === null || !isFinite(value)) return "—"
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatRelativeLog(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

export interface DialogLiveRunProps {
  runId: string
}

export function DialogLiveRun(props: DialogLiveRunProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const live = useLiveRuns()

  // Reactive against the daemon-backed store; updates arrive over the SSE stream.
  const run = () => live.get(props.runId)

  const handleStop = async () => {
    await live.stop(props.runId)
  }

  const close = () => dialog.clear()

  const statusColor = (status?: Run["status"]) => {
    switch (status) {
      case "running":
        return theme.success
      case "starting":
        return theme.warning
      case "stopped":
        return theme.textMuted
      case "error":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  return (
    <Show
      when={run()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <text fg={theme.textMuted}>Run not found.</text>
        </box>
      }
    >
      {(r) => (
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {r().brokerKind === "robinhood" ? "Robinhood Live" : "Live"} · {r().algorithmName}
            </text>
            <text fg={theme.textMuted} onMouseUp={close}>
              esc
            </text>
          </box>

          <box flexDirection="row" gap={2}>
            <text fg={statusColor(r().status)} attributes={TextAttributes.BOLD}>
              {r().status.toUpperCase()}
            </text>
            <ModeBadge mode={r().mode} />
            <text fg={theme.textMuted}>
              {r().symbol} · {r().interval}
            </text>
          </box>

          <box flexDirection="row" gap={3} paddingTop={1}>
            <box flexDirection="column">
              <text fg={theme.textMuted}>Cash</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {formatCurrency(r().cash)}
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.textMuted}>Equity</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {formatCurrency(r().equity)}
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.textMuted}>Position</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {r().positions[r().symbol] ?? 0}
              </text>
            </box>
          </box>

          <Show when={r().lastBar}>
            {(bar) => (
              <text fg={theme.textMuted}>
                Last bar: {bar().timestamp} · close {bar().close.toFixed(2)}
              </text>
            )}
          </Show>

          {/* Logs */}
          <box paddingTop={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Logs
            </text>
          </box>
          <box
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            height={18}
          >
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
              <box flexDirection="column">
                <For each={r().logs.slice(-80)}>
                  {(entry) => {
                    const color =
                      entry.level === "error" ? theme.error : entry.level === "warn" ? theme.warning : theme.text
                    return (
                      <text fg={color}>
                        <span style={{ fg: theme.textMuted }}>{formatRelativeLog(entry.ts)}</span> {entry.message}
                      </text>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
          </box>

          <Show when={r().error}>
            {(err) => (
              <box paddingLeft={1} paddingRight={1} border={["left"]} borderColor={theme.error}>
                <text fg={theme.error}>{err()}</text>
              </box>
            )}
          </Show>

          <box paddingTop={1} flexDirection="row" gap={2}>
            <Show
              when={r().status === "running" || r().status === "starting"}
              fallback={
                <box paddingLeft={2} paddingRight={2} onMouseUp={close}>
                  <text fg={theme.textMuted}>close</text>
                </box>
              }
            >
              <box paddingLeft={2} paddingRight={2} backgroundColor={theme.error} onMouseUp={handleStop}>
                <text fg={theme.background} attributes={TextAttributes.BOLD}>
                  ■ Stop
                </text>
              </box>
            </Show>
          </box>
        </box>
      )}
    </Show>
  )
}

DialogLiveRun.show = (dialog: DialogContext, runId: string) => {
  dialog.setSize("xlarge")
  dialog.replace(() => <DialogLiveRun runId={runId} />)
}
