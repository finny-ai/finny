import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { createRobinhoodIntegrationClient, type RobinhoodConnection } from "../util/robinhood-integration"

type BusyAction = "loading" | "connecting" | "disconnecting"

function Action(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
}) {
  const { theme } = useTheme()
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      height={1}
      flexShrink={0}
      backgroundColor={props.disabled ? theme.borderSubtle : props.primary ? theme.primary : theme.backgroundElement}
      onMouseUp={() => {
        if (!props.disabled) props.onClick()
      }}
    >
      <text
        fg={
          props.disabled ? theme.textMuted : props.primary ? theme.background : props.danger ? theme.error : theme.text
        }
        attributes={TextAttributes.BOLD}
      >
        {props.label}
      </text>
    </box>
  )
}

export function RobinhoodManager(props: { onChanged?: () => void } = {}) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const client = createRobinhoodIntegrationClient(sdk)
  const [connection, setConnection] = createSignal<RobinhoodConnection>()
  const [busy, setBusy] = createSignal<BusyAction>()
  const [error, setError] = createSignal<string>()

  const load = async () => {
    if (busy()) return
    setBusy("loading")
    setError(undefined)
    try {
      setConnection(await client.status())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => void load())

  const connect = async () => {
    if (busy()) return
    setBusy("connecting")
    setError(undefined)
    try {
      const next = await client.connect()
      setConnection(next)
      await local.brokerage.set("robinhood").catch(() => {
        toast.show({
          message: "Robinhood connected, but the local brokerage preference could not be saved",
          variant: "warning",
          duration: 5000,
        })
      })
      props.onChanged?.()
      toast.show({ message: "Robinhood connected", variant: "success", duration: 3500 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const disconnect = async () => {
    if (busy()) return
    setBusy("disconnecting")
    setError(undefined)
    try {
      setConnection(await client.disconnect())
      await local.brokerage.clear("robinhood").catch(() => {
        toast.show({
          message: "Robinhood disconnected, but the local brokerage preference could not be cleared",
          variant: "warning",
          duration: 5000,
        })
      })
      props.onChanged?.()
      toast.show({ message: "Robinhood disconnected", variant: "info", duration: 3500 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <box flexDirection="column" gap={1}>
      <box
        border={["left"]}
        borderColor={connection()?.connected ? theme.success : theme.border}
        paddingLeft={2}
        flexDirection="column"
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Robinhood
            </text>
            <text fg={theme.textMuted}>Official Robinhood connection · OAuth opens in your browser</text>
          </box>
          <text fg={connection()?.connected ? theme.success : theme.textMuted} attributes={TextAttributes.BOLD}>
            {connection()?.connected ? "Connected" : "Not connected"}
          </text>
        </box>

        <text fg={theme.textMuted}>
          {connection()?.connected
            ? "Connected for analysis. Trade Live separately checks execution compatibility for each strict run."
            : "Connect for Robinhood analysis. Live execution requires separate compatibility and risk checks."}
        </text>

        <box flexDirection="row" gap={1}>
          <Show
            when={connection()?.connected}
            fallback={
              <Action
                label={busy() === "connecting" ? "Connecting…" : "Connect Robinhood"}
                primary
                disabled={!!busy()}
                onClick={() => void connect()}
              />
            }
          >
            <Action
              label={busy() === "disconnecting" ? "Disconnecting…" : "Disconnect"}
              danger
              disabled={!!busy()}
              onClick={() => void disconnect()}
            />
          </Show>
          <Action
            label={busy() === "loading" ? "Refreshing…" : "Refresh"}
            disabled={!!busy()}
            onClick={() => void load()}
          />
        </box>

        <Show when={connection()?.message}>
          <text fg={theme.textMuted}>{connection()?.message}</text>
        </Show>
      </box>

      <Show when={error()}>
        <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
          <text fg={theme.error} wrapMode="word">
            {error()}
          </text>
        </box>
      </Show>
    </box>
  )
}

export function DialogRobinhood(props: { onChanged?: () => void } = {}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => dialog.setSize("large"))

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      height={Math.max(14, Math.min(22, dimensions().height - 8))}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Manage Robinhood
          </text>
          <text fg={theme.textMuted}>Official Robinhood OAuth</text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <RobinhoodManager onChanged={props.onChanged} />
    </box>
  )
}

DialogRobinhood.show = (dialog: DialogContext, options: { onChanged?: () => void } = {}) =>
  new Promise<void>((resolve) => {
    dialog.replace(() => <DialogRobinhood onChanged={options.onChanged} />, resolve)
  })
