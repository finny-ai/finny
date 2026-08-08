import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { MouseEvent, TextAttributes, TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import type { Algorithm } from "@/algorithm"
import { maskKey } from "@/live/alpaca-accounts"
import { BrokerRegistry, type BrokerAccount, type BrokerKind, type BrokerMode } from "@/live/brokers"
import { createRobinhoodIntegrationClient } from "../util/robinhood-integration"
import {
  brokerSelectableForRunMode,
  brokerVisibleForRunMode,
  committedRobinhoodSymbol,
  createRobinhoodLiveClient,
  robinhoodAgenticAccountLabel,
  robinhoodLiveBlocker,
  robinhoodPreflightExpiryLabel,
  robinhoodPreflightStartBlocker,
  robinhoodTradeLiveAvailability,
  type RobinhoodLivePreflight,
} from "../util/robinhood-live"

const INTERVAL_OPTIONS = ["1min", "5min", "15min", "30min", "1h", "4h", "1d"] as const

type Intervals = (typeof INTERVAL_OPTIONS)[number]
type RunMode = "paper" | "live"

function normalizeInterval(value: string | undefined): Intervals {
  if (!value) return "1min"
  const v = value.toLowerCase().trim()
  const aliases: Record<string, Intervals> = {
    "1m": "1min",
    "1min": "1min",
    "1minute": "1min",
    "5m": "5min",
    "5min": "5min",
    "5minute": "5min",
    "15m": "15min",
    "15min": "15min",
    "30m": "30min",
    "30min": "30min",
    "1h": "1h",
    "60m": "1h",
    "1hour": "1h",
    "60min": "1h",
    "4h": "4h",
    "240m": "4h",
    "4hour": "4h",
    "1d": "1d",
    "1day": "1d",
    daily: "1d",
  }
  return aliases[v] ?? "1min"
}

function formatFee(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

function accountModeLabel(mode: BrokerMode | undefined): string {
  if (mode === "live") return "live"
  if (mode === "testnet") return "testnet"
  return "paper"
}

function accountMatchesRunMode(account: BrokerAccount, runMode: RunMode): boolean {
  return runMode === "live" ? account.mode === "live" : account.mode !== "live"
}

function runModeTitle(runMode: RunMode): string {
  return runMode === "live" ? "Live" : "Paper Trading"
}

export interface ConfirmResult {
  symbol: string
  interval: Intervals
  brokerKind: BrokerKind
  accountProviderID: string
  challengeId?: string
}

export interface DialogLiveConfirmProps {
  algorithm: Algorithm.Info
  runMode: RunMode
  runId: string
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
  const sdk = useSDK()
  const robinhood = createRobinhoodIntegrationClient(sdk)
  const robinhoodLive = createRobinhoodLiveClient(sdk)
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
  const [robinhoodConnected, setRobinhoodConnected] = createSignal(false)
  const [preflight, setPreflight] = createSignal<RobinhoodLivePreflight>()
  const [preflightSymbol, setPreflightSymbol] = createSignal<string>()
  const [preflightBusy, setPreflightBusy] = createSignal(false)
  const [preflightError, setPreflightError] = createSignal<string>()
  const [robinhoodAvailability, setRobinhoodAvailability] = createSignal(
    robinhoodTradeLiveAvailability({ connected: false, hasStrictRun: true }),
  )
  let preflightRequest = 0
  let preflightController: AbortController | undefined
  const accountsForRow = (row: BrokerRegistry.BrokerComparison) =>
    row.accounts.filter((account) => accountMatchesRunMode(account, props.runMode))
  const visibleComparison = createMemo(() =>
    comparison().filter((row) => brokerVisibleForRunMode(row.spec.kind, props.runMode)),
  )
  const brokerSelectable = (row: BrokerRegistry.BrokerComparison) =>
    brokerSelectableForRunMode({
      kind: row.spec.kind,
      runMode: props.runMode,
      supports: row.supports,
      robinhoodConnected: robinhoodConnected(),
      robinhoodExecutionCompatible: robinhoodAvailability().available,
    })

  const refresh = async (sym: string) => {
    const c = await BrokerRegistry.compareForSymbol(sym)
    setComparison(c)
    // Preserve the user's broker pick if it's still supported. Otherwise prefer
    // the chat-supplied default if it supports the symbol, then fall back to
    // the first broker that supports it (preferring one with accounts).
    const cur = selectedKind()
    const visible = c.filter((row) => brokerVisibleForRunMode(row.spec.kind, props.runMode))
    const curRow = cur ? visible.find((r) => r.spec.kind === cur) : null
    if (!curRow || !brokerSelectable(curRow)) {
      const fromChat = props.defaultBrokerKind
        ? visible.find((row) => row.spec.kind === props.defaultBrokerKind && brokerSelectable(row))
        : null
      const eligible = visible.find((row) => brokerSelectable(row) && accountsForRow(row).length > 0)
      const fallback = visible.find(brokerSelectable)
      setSelectedKind((fromChat ?? eligible ?? fallback)?.spec.kind ?? null)
    }
    const acctMap: Record<string, string> = { ...accountByKind() }
    for (const row of c) {
      const accounts = accountsForRow(row)
      if (!accounts.some((account) => account.providerID === acctMap[row.spec.kind])) {
        if (accounts[0]) acctMap[row.spec.kind] = accounts[0].providerID
        else delete acctMap[row.spec.kind]
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
    if (!row || !brokerSelectable(row)) return
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

  const activateBroker = (row: BrokerRegistry.BrokerComparison) => {
    if (row.spec.kind === "robinhood" && !brokerSelectable(row)) {
      if (props.runMode === "live" && robinhoodConnected() && !preflightBusy()) {
        void checkRobinhood(symbolInput()).then(() => {
          const current = comparison().find((candidate) => candidate.spec.kind === "robinhood")
          if (current && brokerSelectable(current)) pickBroker("robinhood")
        })
      }
      return
    }
    pickBroker(row.spec.kind)
  }

  const checkRobinhood = async (sym: string) => {
    if (props.runMode !== "live") return
    const request = ++preflightRequest
    preflightController?.abort()
    const controller = new AbortController()
    preflightController = controller
    setPreflightBusy(true)
    setPreflight(undefined)
    setPreflightSymbol(undefined)
    setPreflightError(undefined)
    setRobinhoodAvailability({
      available: false,
      state: "pending",
      description: "Unavailable · checking execution compatibility",
    })
    try {
      const connected = await robinhood
        .status({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
        .then((status) => status.connected)
      if (request !== preflightRequest) return
      setRobinhoodConnected(connected)
      if (!connected) {
        setRobinhoodAvailability(robinhoodTradeLiveAvailability({ connected: false, hasStrictRun: true }))
        return
      }
      const result = await robinhoodLive.preflight(
        {
          algorithmId: props.algorithm.algorithmId,
          runId: props.runId,
          symbol: committedRobinhoodSymbol(sym, props.defaultSymbol),
          interval,
          executionMode: "live",
        },
        { signal: controller.signal },
      )
      if (request !== preflightRequest) return
      const availability = robinhoodTradeLiveAvailability({ connected: true, hasStrictRun: true, preflight: result })
      setPreflight(result)
      setPreflightSymbol(committedRobinhoodSymbol(sym, props.defaultSymbol))
      setRobinhoodAvailability(availability)
      if (availability.available && props.defaultBrokerKind === "robinhood") setSelectedKind("robinhood")
      if (!availability.available && selectedKind() === "robinhood") setSelectedKind(null)
    } catch (cause) {
      if (request !== preflightRequest || controller.signal.aborted) return
      setRobinhoodAvailability(
        robinhoodTradeLiveAvailability({ connected: true, hasStrictRun: true, checkFailed: true }),
      )
      setPreflightError(cause instanceof Error ? cause.message : String(cause))
      if (selectedKind() === "robinhood") setSelectedKind(null)
    } finally {
      if (request === preflightRequest) setPreflightBusy(false)
    }
  }

  onMount(() => {
    dialog.setSize("large")
    void refresh(props.defaultSymbol.trim().toUpperCase())
    if (props.runMode === "live" && props.defaultBrokerKind === "robinhood") {
      void checkRobinhood(props.defaultSymbol)
    } else if (props.runMode === "live") {
      void robinhood
        .status({ signal: AbortSignal.timeout(5_000) })
        .then((status) => {
          setRobinhoodConnected(status.connected)
          setRobinhoodAvailability(
            status.connected
              ? {
                  available: false,
                  state: "pending",
                  description: "Select Robinhood to check live execution compatibility",
                }
              : robinhoodTradeLiveAvailability({ connected: false, hasStrictRun: true }),
          )
        })
        .catch(() => setRobinhoodConnected(false))
    }
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
    if (norm) {
      void refresh(norm)
      if (selectedKind() === "robinhood") void checkRobinhood(norm)
      else if (preflight()) {
        setPreflight(undefined)
        setPreflightSymbol(undefined)
        setRobinhoodAvailability({
          available: false,
          state: "pending",
          description: "Select Robinhood to check live execution compatibility",
        })
      }
    }
  }, 250)
  onCleanup(() => {
    clearInterval(poll)
    preflightController?.abort()
  })

  const selectedRow = createMemo(() => {
    const k = selectedKind()
    if (!k) return null
    return comparison().find((r) => r.spec.kind === k) ?? null
  })

  const canConfirm = createMemo(() => {
    const row = selectedRow()
    if (!row || !row.supports) return false
    if (row.spec.kind === "robinhood") {
      return brokerSelectable(row) && !preflightBusy()
    }
    const acctId = accountByKind()[row.spec.kind]
    return Boolean(acctId && accountsForRow(row).some((account) => account.providerID === acctId))
  })

  // First "Start" click: move to the disclaimer step. The run only fires
  // after the user explicitly confirms on the disclaimer screen.
  const requestStart = async () => {
    if (!canConfirm()) return
    // Snapshot the typed symbol now while the textarea is still mounted.
    const sym = committedRobinhoodSymbol(symbolTextarea?.plainText ?? symbolInput(), props.defaultSymbol)
    setPendingSymbol(sym)
    if (selectedKind() === "robinhood") {
      const existingBlocker =
        preflightSymbol() === sym
          ? robinhoodPreflightStartBlocker(preflight())
          : "The Robinhood symbol changed. Check eligibility again."
      if (!existingBlocker) {
        setStep("disclaimer")
        return
      }
      setPreflightBusy(true)
      setPreflightError(undefined)
      try {
        const result = await robinhoodLive.preflight(
          {
            algorithmId: props.algorithm.algorithmId,
            runId: props.runId,
            symbol: sym,
            interval,
            executionMode: "live",
          },
          { signal: preflightController?.signal },
        )
        setPreflight(result)
        setPreflightSymbol(sym)
        const blocker = robinhoodLiveBlocker(result)
        if (blocker) {
          setPreflightError(blocker)
          return
        }
      } catch (cause) {
        setPreflightError(cause instanceof Error ? cause.message : String(cause))
        return
      } finally {
        setPreflightBusy(false)
      }
    }
    setStep("disclaimer")
  }

  // Snapshot the symbol at the moment we enter the disclaimer step. The
  // textarea is unmounted on step 2 so we can't read it then.
  const [pendingSymbol, setPendingSymbol] = createSignal<string>(props.defaultSymbol)

  const actuallyStart = () => {
    const row = selectedRow()
    if (!row) return
    if (row.spec.kind === "robinhood") {
      const ready = preflight()
      const blocker = robinhoodPreflightStartBlocker(ready)
      if (blocker || !ready?.account || !ready.challengeId) {
        setPreflightError(blocker ?? "Robinhood live confirmation is no longer valid.")
        setStep("pick")
        setPreflight(undefined)
        setPreflightSymbol(undefined)
        setRobinhoodAvailability({
          available: false,
          state: "pending",
          description: "Select Robinhood to check live execution compatibility again",
        })
        return
      }
      props.onConfirm({
        symbol: pendingSymbol(),
        interval,
        brokerKind: "robinhood",
        accountProviderID: ready.account.accountProviderID,
        challengeId: ready.challengeId,
      })
      return
    }
    const acctId = accountByKind()[row.spec.kind]
    if (!acctId || !accountsForRow(row).some((account) => account.providerID === acctId)) return
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
          Run ·{" "}
          {props.runMode === "live" && selectedKind() === "robinhood" ? "Robinhood Live" : runModeTitle(props.runMode)}{" "}
          · {props.algorithm.name}
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          esc
        </text>
      </box>

      <Show when={step() === "pick"}>
        <text fg={theme.textMuted}>
          Choose a {props.runMode === "live" ? "live" : "paper/testnet"} brokerage account. Compare native pair and fees
          before starting.
        </text>

        {/* Symbol */}
        <box paddingTop={1}>
          <text fg={theme.textMuted}>Symbol</text>
        </box>
        <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} height={1}>
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
          <For each={visibleComparison()}>
            {(row) => {
              const isActive = () => selectedKind() === row.spec.kind
              const accounts = () => accountsForRow(row)
              const selectedAcctId = () => accountByKind()[row.spec.kind] ?? ""
              const setAcct = (id: string) => setAccountByKind({ ...accountByKind(), [row.spec.kind]: id })
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
                  onMouseUp={() => activateBroker(row)}
                >
                  <box flexDirection="row" gap={2} flexShrink={0}>
                    <text
                      fg={isActive() ? theme.primary : brokerSelectable(row) ? theme.text : theme.textMuted}
                      attributes={TextAttributes.BOLD}
                    >
                      {isActive() ? "●" : "○"} {row.spec.displayName}
                    </text>
                    <Show
                      when={row.supports}
                      fallback={<text fg={theme.textMuted}>does not support {symbolInput()}</text>}
                    >
                      <text fg={theme.textMuted}>{row.nativeSymbol}</text>
                      <text fg={theme.textMuted}>fee {formatFee(row.takerFee)}</text>
                    </Show>
                  </box>
                  <Show when={row.supports && row.spec.kind === "robinhood"}>
                    <text fg={theme.warning}>
                      {preflightBusy() ? "Checking live execution compatibility…" : robinhoodAvailability().description}
                    </text>
                  </Show>
                  <Show when={row.supports && row.spec.kind !== "robinhood" && accounts().length === 0}>
                    <text fg={theme.warning}>
                      No {props.runMode === "live" ? "live" : "paper/testnet"} {row.spec.displayName} accounts. Settings
                      → Brokerages.
                    </text>
                  </Show>
                  <Show when={row.supports && row.spec.kind !== "robinhood" && accounts().length === 1}>
                    <text fg={theme.textMuted}>
                      Account: {accounts()[0].label} ({maskKey(accounts()[0].keyId)}) ·{" "}
                      {accountModeLabel(accounts()[0].mode)}
                    </text>
                  </Show>
                  <Show when={row.supports && row.spec.kind !== "robinhood" && accounts().length >= 2}>
                    <box flexDirection="row" gap={1} paddingTop={0}>
                      <For each={accounts()}>
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
                                {acct.label} · {accountModeLabel(acct.mode)}
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
          <Show when={canConfirm() || preflightBusy()}>
            <box paddingLeft={2} paddingRight={2} backgroundColor={theme.success} onMouseUp={() => void requestStart()}>
              <text fg={theme.background} attributes={TextAttributes.BOLD}>
                {preflightBusy() ? "Checking live eligibility…" : `▶ Continue on ${selectedRow()?.spec.displayName}`}
              </text>
            </box>
          </Show>
        </box>
        <Show when={preflightError()}>
          <text fg={theme.error} wrapMode="word">
            Robinhood live blocked: {preflightError()}
          </text>
        </Show>
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
            {props.algorithm.name} · immutable version {props.algorithm.version}
          </text>
          <text fg={theme.textMuted}>Strict backtest run: {props.runId}</text>
          <box flexDirection="row" gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>broker</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {selectedRow()?.spec.displayName}
            </text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.textMuted}>pair</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {selectedKind() === "robinhood" ? pendingSymbol() : selectedRow()?.nativeSymbol}
            </text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.textMuted}>interval</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {interval}
            </text>
            <Show when={preflight()?.account}>
              {(account) => (
                <>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.textMuted}>account</text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {robinhoodAgenticAccountLabel(account())}
                  </text>
                </>
              )}
            </Show>
            <Show
              when={preflight()?.account}
              fallback={
                <Show when={props.defaultEquityUsd !== undefined}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.textMuted}>equity</text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    ${props.defaultEquityUsd}
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>·</text>
              <text fg={theme.textMuted}>equity</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ${preflight()?.account?.equity.toLocaleString()}
              </text>
            </Show>
          </box>
        </box>

        <Show when={preflight()?.risk}>
          {(risk) => (
            <box border={["left"]} borderColor={theme.warning} paddingLeft={2} flexDirection="column">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Risk limits
              </text>
              <text fg={theme.textMuted}>
                max positions {risk().maxPositions} · drawdown {risk().drawdownLimitPct}% · sizing stop distance{" "}
                {risk().sizingStopDistancePct}% · protective stop {risk().protectiveStopMode}
              </text>
              <Show when={risk().maxGrossExposurePct !== undefined}>
                <text fg={theme.textMuted}>
                  gross {risk().maxGrossExposurePct}% · net {risk().maxNetExposurePct}% · per symbol{" "}
                  {risk().maxSymbolExposurePct}% · flatten on stop {risk().flattenOnStop ? "yes" : "no"}
                </text>
              </Show>
            </box>
          )}
        </Show>

        <Show when={preflight()}>
          {(result) => (
            <box border={["left"]} borderColor={theme.info} paddingLeft={2} flexDirection="column">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Current Robinhood preflight
              </text>
              <text fg={theme.textMuted}>
                Positions:{" "}
                {result().positions.length === 0
                  ? "none"
                  : result()
                      .positions.map((position) => `${position.symbol} ${position.qty} @ $${position.mark}`)
                      .join(" · ")}
              </text>
              <text fg={theme.textMuted}>
                Open orders:{" "}
                {result().openOrders.length === 0
                  ? "none"
                  : result()
                      .openOrders.map((order) => `${order.side} ${order.qty} ${order.symbol} (${order.status})`)
                      .join(" · ")}
              </text>
              <text fg={theme.textMuted}>
                Challenge expires: {result().expiresAt ? robinhoodPreflightExpiryLabel(result().expiresAt!) : "Unknown"}
              </text>
            </box>
          )}
        </Show>

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
          <Show when={selectedKind() === "robinhood"}>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>
              REAL MONEY: Robinhood will submit actual orders in your dedicated Agentic account. Losses can exceed
              backtest expectations.
            </text>
          </Show>
          <text fg={theme.textMuted}>
            The Finny daemon owns this run. Closing the TUI does not stop it; return here to monitor or stop the
            strategy.
          </text>
          <text fg={theme.textMuted}>
            Not investment advice. Backtest and paper results do not predict live performance.
          </text>
        </box>

        <box paddingTop={1} flexDirection="row" gap={2}>
          <box paddingLeft={2} paddingRight={2} backgroundColor={theme.success} onMouseUp={actuallyStart}>
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              {selectedKind() === "robinhood"
                ? "▶ I understand this uses real money"
                : "▶ I understand, start the run"}
            </text>
          </box>
          <box paddingLeft={2} paddingRight={2} backgroundColor={theme.backgroundElement} onMouseUp={backToPick}>
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
    runMode: RunMode
    runId: string
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
          runMode={defaults.runMode}
          runId={defaults.runId}
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
