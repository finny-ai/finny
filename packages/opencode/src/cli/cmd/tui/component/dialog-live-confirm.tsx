import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { MouseEvent, TextAttributes, TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import type { Algorithm } from "@/algorithm"
import { maskKey } from "@/live/alpaca-accounts"
import { BrokerRegistry, type BrokerKind } from "@/live/brokers"

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

function formatFee(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

export interface ConfirmResult {
  symbol: string
  interval: Intervals
  brokerKind: BrokerKind
  accountProviderID: string
}

export interface DialogLiveConfirmProps {
  algorithm: Algorithm.Info
  defaultSymbol: string
  defaultInterval: Intervals
  defaultBrokerKind?: BrokerKind
  defaultEquityUsd?: number
  onConfirm: (params: ConfirmResult) => void
  onCancel: () => void
}

export function DialogLiveConfirm(props: DialogLiveConfirmProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const interval = normalizeInterval(props.defaultInterval)
  let symbolTextarea: TextareaRenderable | undefined

  const [symbolInput, setSymbolInput] = createSignal(props.defaultSymbol)
  const [comparison, setComparison] = createSignal<BrokerRegistry.BrokerComparison[]>([])
  const [selectedKind, setSelectedKind] = createSignal<BrokerKind | null>(null)
  // Per-broker account selection.
  const [accountByKind, setAccountByKind] = createSignal<Record<string, string>>({})
  // Two-step flow: "pick" → user configures broker. "disclaimer" → final ack
  // before the run actually fires.
  const [step, setStep] = createSignal<"pick" | "disclaimer">("pick")

  const refresh = async (sym: string) => {
    const c = await BrokerRegistry.compareForSymbol(sym)
    setComparison(c)
    // Preserve the user's broker pick if it's still supported. Otherwise prefer
    // the chat-supplied default if it supports the symbol, then fall back to
    // the first broker that supports it (preferring one with accounts).
    const cur = selectedKind()
    const curRow = cur ? c.find((r) => r.spec.kind === cur) : null
    if (!curRow || !curRow.supports) {
      const fromChat = props.defaultBrokerKind
        ? c.find((row) => row.spec.kind === props.defaultBrokerKind && row.supports)
        : null
      const eligible = c.find((row) => row.supports && row.accounts.length > 0)
      const fallback = c.find((row) => row.supports) ?? c[0]
      setSelectedKind((fromChat ?? eligible ?? fallback)?.spec.kind ?? null)
    }
    const acctMap: Record<string, string> = { ...accountByKind() }
    for (const row of c) {
      if (!acctMap[row.spec.kind] && row.accounts.length > 0) {
        acctMap[row.spec.kind] = row.accounts[0].providerID
      }
    }
    setAccountByKind(acctMap)
  }

  // The opentui <textarea> doesn't expose onInput, so we poll plainText to
  // detect typing. `lastSeen` also gates the broker auto-rewrite so we don't
  // re-fire refresh on values we just wrote ourselves.
  let lastSeen = props.defaultSymbol.trim().toUpperCase()

  // User picks a broker. Auto-rewrite the symbol field to that broker's
  // native pair (BTC/USD ↔ BTC/USDT) so the run goes against a tradable pair.
  const pickBroker = (kind: BrokerKind) => {
    const row = comparison().find((r) => r.spec.kind === kind)
    if (!row || !row.supports) return
    setSelectedKind(kind)
    if (!symbolTextarea || symbolTextarea.isDestroyed) return
    const current = (symbolTextarea.plainText ?? "").trim().toUpperCase()
    const target = row.nativeSymbol.toUpperCase()
    if (current === target) return
    symbolTextarea.setText(target)
    lastSeen = target
    setSymbolInput(target)
    void refresh(target)
  }

  onMount(() => {
    void refresh(props.defaultSymbol.trim().toUpperCase())
    setTimeout(() => {
      if (symbolTextarea && !symbolTextarea.isDestroyed) {
        symbolTextarea.focus()
        symbolTextarea.gotoLineEnd()
      }
    }, 1)
  })

  const poll = setInterval(() => {
    if (!symbolTextarea || symbolTextarea.isDestroyed) return
    const norm = (symbolTextarea.plainText ?? "").trim().toUpperCase()
    if (norm === lastSeen) return
    lastSeen = norm
    setSymbolInput(norm)
    if (norm) void refresh(norm)
  }, 250)
  onCleanup(() => clearInterval(poll))

  const selectedRow = createMemo(() => {
    const k = selectedKind()
    if (!k) return null
    return comparison().find((r) => r.spec.kind === k) ?? null
  })

  const canConfirm = createMemo(() => {
    const row = selectedRow()
    if (!row || !row.supports) return false
    const acctId = accountByKind()[row.spec.kind]
    return Boolean(acctId)
  })

  // First "Start" click: move to the disclaimer step. The run only fires
  // after the user explicitly confirms on the disclaimer screen.
  const requestStart = () => {
    if (!canConfirm()) return
    // Snapshot the typed symbol now while the textarea is still mounted.
    const sym = (symbolTextarea?.plainText ?? symbolInput() ?? props.defaultSymbol).trim().toUpperCase()
    setPendingSymbol(sym || props.defaultSymbol)
    setStep("disclaimer")
  }

  // Snapshot the symbol at the moment we enter the disclaimer step. The
  // textarea is unmounted on step 2 so we can't read it then.
  const [pendingSymbol, setPendingSymbol] = createSignal<string>(props.defaultSymbol)

  const actuallyStart = () => {
    const row = selectedRow()
    if (!row) return
    const acctId = accountByKind()[row.spec.kind]
    if (!acctId) return
    const sym = (pendingSymbol() || props.defaultSymbol).trim().toUpperCase()
    props.onConfirm({
      symbol: sym || props.defaultSymbol,
      interval,
      brokerKind: row.spec.kind,
      accountProviderID: acctId,
    })
  }

  const backToPick = () => setStep("pick")

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

      <Show when={step() === "pick"}>
      <text fg={theme.textMuted}>
        Choose a brokerage to run this algorithm against. Compare native pair and fees before starting.
      </text>

      {/* Symbol */}
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

      {/* Interval */}
      <box paddingTop={1}>
        <text fg={theme.textMuted}>Interval</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {interval}
        </text>
        <text fg={theme.textMuted}>(fixed by algorithm)</text>
      </box>

      {/* Brokerage comparison */}
      <box paddingTop={1}>
        <text fg={theme.textMuted}>Pick brokerage</text>
      </box>
      <box flexDirection="column" gap={1}>
        <For each={comparison()}>
          {(row) => {
            const isActive = () => selectedKind() === row.spec.kind
            const accountsForRow = () => row.accounts
            const selectedAcctId = () => accountByKind()[row.spec.kind] ?? ""
            const setAcct = (id: string) =>
              setAccountByKind({ ...accountByKind(), [row.spec.kind]: id })
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                paddingTop={0}
                paddingBottom={0}
                backgroundColor={isActive() ? theme.backgroundElement : undefined}
                border={isActive() ? ["left"] : undefined}
                borderColor={theme.primary}
                flexDirection="column"
                gap={0}
                onMouseUp={() => row.supports && pickBroker(row.spec.kind)}
              >
                <box flexDirection="row" gap={2} flexShrink={0}>
                  <text
                    fg={isActive() ? theme.primary : row.supports ? theme.text : theme.textMuted}
                    attributes={TextAttributes.BOLD}
                  >
                    {isActive() ? "●" : "○"} {row.spec.displayName}
                  </text>
                  <Show when={row.supports} fallback={<text fg={theme.textMuted}>does not support {symbolInput()}</text>}>
                    <text fg={theme.textMuted}>{row.nativeSymbol}</text>
                    <text fg={theme.textMuted}>fee {formatFee(row.takerFee)}</text>
                  </Show>
                </box>
                <Show when={row.supports && accountsForRow().length === 0}>
                  <text fg={theme.warning}>
                    No {row.spec.displayName} accounts. Settings → Brokerages.
                  </text>
                </Show>
                <Show when={row.supports && accountsForRow().length === 1}>
                  <text fg={theme.textMuted}>
                    Account: {accountsForRow()[0].label} ({maskKey(accountsForRow()[0].keyId)})
                  </text>
                </Show>
                <Show when={row.supports && accountsForRow().length >= 2}>
                  <box flexDirection="row" gap={1} paddingTop={0}>
                    <For each={accountsForRow()}>
                      {(acct) => {
                        const acctActive = () => selectedAcctId() === acct.providerID
                        return (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={acctActive() ? theme.primary : theme.backgroundElement}
                            onMouseUp={(e: MouseEvent) => {
                              e?.stopPropagation?.()
                              pickBroker(row.spec.kind)
                              setAcct(acct.providerID)
                            }}
                          >
                            <text
                              fg={acctActive() ? theme.background : theme.textMuted}
                              attributes={acctActive() ? TextAttributes.BOLD : 0}
                            >
                              {acct.label}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </box>

      <box paddingTop={1} flexDirection="row" gap={2}>
        <Show when={canConfirm()}>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.success}
            onMouseUp={requestStart}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              ▶ Start on {selectedRow()?.spec.displayName}
            </text>
          </box>
        </Show>
      </box>
      </Show>

      {/* Step 2: disclaimer + final confirm */}
      <Show when={step() === "disclaimer"}>
        {/* Summary card */}
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.backgroundElement}
          flexDirection="column"
          gap={0}
        >
          <text fg={theme.textMuted}>About to start</text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.algorithm.name}
          </text>
          <box flexDirection="row" gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>broker</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {selectedRow()?.spec.displayName}
            </text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.textMuted}>pair</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {selectedRow()?.nativeSymbol}
            </text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.textMuted}>interval</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {interval}
            </text>
            <Show when={props.defaultEquityUsd !== undefined}>
              <text fg={theme.textMuted}>·</text>
              <text fg={theme.textMuted}>equity</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ${props.defaultEquityUsd}
              </text>
            </Show>
          </box>
        </box>

        {/* Warning */}
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          border={["left"]}
          borderColor={theme.info}
          flexDirection="column"
          gap={1}
        >
          <text fg={theme.info} attributes={TextAttributes.BOLD}>
            Read before running
          </text>
          <text fg={theme.textMuted}>
            This run is bound to your Finny session. If you close Finny, the Python worker dies and
            any open positions stay at the broker without being managed by the strategy.
          </text>
          <text fg={theme.textMuted}>
            Not investment advice. Backtest and paper results do not predict live performance.
          </text>
        </box>

        <box paddingTop={1} flexDirection="row" gap={2}>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.success}
            onMouseUp={actuallyStart}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              ▶ I understand, start the run
            </text>
          </box>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={theme.backgroundElement}
            onMouseUp={backToPick}
          >
            <text fg={theme.text}>← Back</text>
          </box>
        </box>
      </Show>
    </box>
  )
}

DialogLiveConfirm.show = (
  dialog: DialogContext,
  algorithm: Algorithm.Info,
  defaults: {
    symbol: string
    interval: Intervals
    brokerKind?: BrokerKind
    equityUsd?: number
  },
) => {
  return new Promise<ConfirmResult | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogLiveConfirm
          algorithm={algorithm}
          defaultSymbol={defaults.symbol}
          defaultInterval={defaults.interval}
          defaultBrokerKind={defaults.brokerKind}
          defaultEquityUsd={defaults.equityUsd}
          onConfirm={(params) => resolve(params)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
