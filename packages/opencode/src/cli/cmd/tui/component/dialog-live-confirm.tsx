import { createSignal, For, onMount, Show } from "solid-js"
import { MouseEvent, TextAttributes, TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import type { Algorithm } from "@/algorithm"
import {
  type AlpacaAccount,
  listAlpacaAccounts,
  maskKey,
} from "@/live/alpaca-accounts"

const INTERVAL_OPTIONS = ["1min", "5min", "15min", "30min", "1h", "4h", "1d"] as const

type Intervals = (typeof INTERVAL_OPTIONS)[number]

function normalizeInterval(value: string | undefined): Intervals {
  if (!value) return "1min"
  const v = value.toLowerCase().trim()
  const aliases: Record<string, Intervals> = {
    "1m": "1min", "1min": "1min", "1minute": "1min",
    "5m": "5min", "5min": "5min", "5minute": "5min",
    "15m": "15min", "15min": "15min",
    "30m": "30min", "30min": "30min",
    "1h": "1h", "60m": "1h", "1hour": "1h", "60min": "1h",
    "4h": "4h", "240m": "4h", "4hour": "4h",
    "1d": "1d", "1day": "1d", "daily": "1d",
  }
  return aliases[v] ?? "1min"
}

export interface ConfirmResult {
  symbol: string
  interval: Intervals
  accountProviderID: string
}

export interface DialogLiveConfirmProps {
  algorithm: Algorithm.Info
  defaultSymbol: string
  defaultInterval: Intervals
  onConfirm: (params: ConfirmResult) => void
  onCancel: () => void
}

export function DialogLiveConfirm(props: DialogLiveConfirmProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const interval = normalizeInterval(props.defaultInterval)
  let symbolTextarea: TextareaRenderable | undefined

  const [accounts, setAccounts] = createSignal<AlpacaAccount[]>([])
  const [selectedAccount, setSelectedAccount] = createSignal<string>("")

  onMount(async () => {
    const accts = await listAlpacaAccounts()
    setAccounts(accts)
    if (accts.length > 0) setSelectedAccount(accts[0].providerID)

    setTimeout(() => {
      if (symbolTextarea && !symbolTextarea.isDestroyed) {
        symbolTextarea.focus()
        symbolTextarea.gotoLineEnd()
      }
    }, 1)
  })

  const confirm = () => {
    const acctId = selectedAccount()
    if (!acctId) return
    const sym = (symbolTextarea?.plainText ?? props.defaultSymbol).trim().toUpperCase()
    props.onConfirm({
      symbol: sym || props.defaultSymbol,
      interval,
      accountProviderID: acctId,
    })
  }

  const cancel = () => {
    props.onCancel()
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Run Live · {props.algorithm.name}
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>
        Start a live trading loop against Alpaca paper with this algorithm.
      </text>

      {/* Account picker — only shown when 2+ accounts exist */}
      <Show when={accounts().length === 0}>
        <box
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          border={["left"]}
          borderColor={theme.error}
        >
          <text fg={theme.error}>
            No Alpaca accounts connected. Go to Settings → Paper Trading to add one.
          </text>
        </box>
      </Show>

      <Show when={accounts().length >= 2}>
        <box paddingTop={1}>
          <text fg={theme.textMuted}>Account</text>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={accounts()}>
            {(acct) => {
              const isActive = () => selectedAccount() === acct.providerID
              return (
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
                  border={isActive() ? ["left", "right", "top", "bottom"] : undefined}
                  borderColor={theme.borderActive}
                  onMouseUp={() => setSelectedAccount(acct.providerID)}
                >
                  <text
                    fg={isActive() ? theme.background : theme.textMuted}
                    attributes={isActive() ? TextAttributes.BOLD : 0}
                  >
                    {acct.label} ({maskKey(acct.keyId)})
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <Show when={accounts().length === 1}>
        <box paddingTop={1} flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>Account:</text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {accounts()[0].label}
          </text>
          <text fg={theme.textMuted}>({maskKey(accounts()[0].keyId)})</text>
        </box>
      </Show>

      <box paddingTop={1}>
        <text fg={theme.textMuted}>Symbol</text>
      </box>
      <box
        backgroundColor={theme.backgroundElement}
        paddingLeft={1}
        paddingRight={1}
        height={1}
      >
        <textarea
          ref={(r: TextareaRenderable) => {
            symbolTextarea = r
          }}
          height={1}
          initialValue={props.defaultSymbol}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          onMouseDown={(r: MouseEvent) => r.target?.focus()}
        />
      </box>

      <box paddingTop={1}>
        <text fg={theme.textMuted}>Interval</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {interval}
        </text>
        <text fg={theme.textMuted}>(fixed by algorithm)</text>
      </box>

      {/* Disclaimer */}
      <box
        paddingTop={1}
        paddingLeft={1}
        paddingRight={1}
        paddingBottom={1}
        border={["left"]}
        borderColor={theme.warning}
        flexDirection="column"
        gap={0}
      >
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          ⚠ Read before running
        </text>
        <text fg={theme.textMuted}>
          The run is bound to this Finny session. If you close Finny, the Python worker dies
          and any open positions stay in Alpaca without being managed by the strategy.
        </text>
        <text fg={theme.textMuted}>
          Not investment advice. Backtest/paper results do not predict live performance.
        </text>
      </box>

      <box paddingTop={1} flexDirection="row" gap={2}>
        <Show when={accounts().length > 0}>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.primary}
            onMouseUp={confirm}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              ▶ Start live run
            </text>
          </box>
        </Show>
        <box paddingLeft={2} paddingRight={2} onMouseUp={cancel}>
          <text fg={theme.textMuted}>cancel</text>
        </box>
      </box>
    </box>
  )
}

DialogLiveConfirm.show = (
  dialog: DialogContext,
  algorithm: Algorithm.Info,
  defaults: { symbol: string; interval: Intervals },
) => {
  return new Promise<ConfirmResult | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogLiveConfirm
          algorithm={algorithm}
          defaultSymbol={defaults.symbol}
          defaultInterval={defaults.interval}
          onConfirm={(params) => resolve(params)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
