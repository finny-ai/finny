import fs from "fs/promises"
import os from "os"
import path from "path"
import crypto from "crypto"
import { Process } from "@/util/process"
import { Log } from "@/util/log"
import type { Algorithm } from "@/algorithm"
import { Validate } from "@/algorithm/validate"
import { FINNY_BROKER_PY } from "@/backtest/broker-py"
import { PythonEnv } from "./python-env"
import { BrokerRegistry, type BrokerKind, type BrokerMode } from "./brokers"
import { validateSymbolForBroker } from "./brokers/policy"
import { LiveLedger } from "./ledger"
import { liveTradingDisabledReason } from "./brokers/live-trading"
import { emit } from "@/analytics/emit"
import { requireBrokerTier } from "@/plan/brokers"
import { License } from "@/license"
import { NativeHedgeLedger, type NativeHedgeLiveEventInput, type NativeHedgeLiveEventType } from "./native-hedge-ledger"
import { verifyPromotion } from "@/backtest/run-integrity"
import type { ControllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"

const log = Log.create({ service: "live" })

export namespace LiveRunner {
  export type RunStatus = "starting" | "running" | "stopped" | "error"

  export interface OrderEvent {
    order_id: string
    symbol: string
    side: string
    qty: number
    price: number
    status: string
    ts: string
    reason?: string
    features?: unknown
  }

  export interface EquitySnapshot {
    cash: number
    equity: number
    positions: Record<string, number>
  }

  export interface LogEntry {
    ts: number
    level: "info" | "warn" | "error"
    message: string
  }

  export interface BarUpdate {
    timestamp: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }

  export interface Run {
    id: string
    algorithmId: string
    algorithmName: string
    backtestRunId: string
    symbol: string
    interval: string
    brokerKind: BrokerKind
    accountProviderID: string
    accountLabel?: string
    mode?: BrokerMode
    /** Project directory this run belongs to (for multi-project isolation in the daemon). */
    directory?: string
    status: RunStatus
    startedAt: number
    stoppedAt?: number
    error?: string
    lastBar?: BarUpdate
    equity?: number
    cash?: number
    positions: Record<string, number>
    orders: OrderEvent[]
    logs: LogEntry[]
  }

  export interface StartParams {
    algorithm: Algorithm.Info
    runId: string
    symbol: string
    interval: string
    accountProviderID: string
    brokerKind?: BrokerKind
    /** Server-derived proof from the authoritative workflow database; never accepted from the HTTP payload. */
    controllerApproval?: ControllerPaperApproval
    /** Project directory the run is scoped to. Set by the HTTP handler. */
    directory?: string
  }

  export type EligibilityStatus =
    | "prototype"
    | "validated"
    | "backtested"
    | "robustness_passed"
    | "paper_eligible"
    | "live_eligible"

  export class StartRejectedError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "LiveRunnerStartRejectedError"
    }
  }

  export interface StartTarget {
    brokerKind: BrokerKind
    symbol: string
  }

  /** Resolve the account/broker/market tuple before any live worker is created. */
  export function resolveStartTarget(
    input: Pick<StartParams, "symbol" | "accountProviderID" | "brokerKind">,
  ): StartTarget {
    const accountBrokerKind = BrokerRegistry.detectKind(input.accountProviderID)
    const brokerKind = input.brokerKind ?? accountBrokerKind

    if (!brokerKind) {
      throw new StartRejectedError(
        `Brokerage account "${input.accountProviderID}" is not recognized. Reconnect it in Settings → Brokerages.`,
      )
    }
    if (accountBrokerKind && accountBrokerKind !== brokerKind) {
      const selected = BrokerRegistry.getSpec(brokerKind)
      const connected = BrokerRegistry.getSpec(accountBrokerKind)
      throw new StartRejectedError(
        `Selected ${selected.displayName}, but account "${input.accountProviderID}" belongs to ${connected.displayName}. Choose a matching account.`,
      )
    }

    const market = validateSymbolForBroker(input.symbol, brokerKind)
    if (!market.ok || !market.normalizedSymbol) {
      throw new StartRejectedError(market.message ?? `Symbol "${input.symbol}" is not supported by this brokerage.`)
    }
    return { brokerKind, symbol: market.normalizedSymbol }
  }

  type DeploymentKey = Pick<Run, "algorithmId" | "accountProviderID" | "symbol">

  /**
   * A strategy may run in several markets/accounts concurrently, but the
   * daemon must never start two workers for the exact same brokerage deployment.
   */
  export function isActiveDeploymentConflict(existing: Run, incoming: DeploymentKey): boolean {
    if (existing.status !== "running" && existing.status !== "starting") return false
    return (
      existing.algorithmId === incoming.algorithmId &&
      existing.accountProviderID === incoming.accountProviderID &&
      existing.symbol.trim().toUpperCase() === incoming.symbol.trim().toUpperCase()
    )
  }

  export function canStartForMode(eligibility: string | null, mode: BrokerMode): boolean {
    if (mode === "live") return eligibility === "live_eligible"
    return eligibility === "paper_eligible"
  }

  export function canRemoveStatus(status: RunStatus): boolean {
    return status === "stopped" || status === "error"
  }

  type RunState = Run & {
    proc: Process.Child
    tmpDir: string
    ledgerSeq: number
    listeners: Set<(run: Run) => void>
    nativeStopRecorded?: boolean
  }

  const runs = new Map<string, RunState>()
  const globalListeners = new Set<(runs: Run[]) => void>()

  function snapshot(state: RunState): Run {
    const { proc: _p, tmpDir: _t, ledgerSeq: _s, listeners: _l, nativeStopRecorded: _n, ...rest } = state
    return { ...rest, positions: { ...rest.positions }, orders: [...rest.orders], logs: [...rest.logs] }
  }

  function notify(state: RunState) {
    const snap = snapshot(state)
    for (const fn of state.listeners) {
      try {
        fn(snap)
      } catch (e) {
        log.warn("run listener threw", { error: e })
      }
    }
    notifyAll()
  }

  function notifyAll() {
    const all = Array.from(runs.values()).map(snapshot)
    for (const fn of globalListeners) {
      try {
        fn(all)
      } catch (e) {
        log.warn("global listener threw", { error: e })
      }
    }
  }

  function pushLog(state: RunState, level: LogEntry["level"], message: string) {
    const entry: LogEntry = { ts: Date.now(), level, message }
    state.logs.push(entry)
    if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500)
  }

  function emitLedger(state: RunState, input: Omit<LiveLedger.EmitInput, "seq">) {
    state.ledgerSeq += 1
    LiveLedger.emit(
      {
        runId: state.id,
        algorithmId: state.algorithmId,
        algorithmName: state.algorithmName,
        symbol: state.symbol,
        interval: state.interval,
        brokerKind: state.brokerKind,
        mode: state.mode,
      },
      { ...input, seq: state.ledgerSeq },
    )
  }

  function isExecutedOrder(status: string | undefined) {
    const normalized = status?.trim().toLowerCase()
    return normalized === "filled" || normalized === "closed"
  }

  // Recurring "Market closed, sleeping 5m" lines are pure noise for telemetry.
  const IGNORED_LIVE_LOG = /market\s+(is\s+)?closed/i

  // Stream a subprocess log line to telemetry (telemetryLiveOrders), tagged with
  // the run's broker + mode. Drops the market-closed noise. Local state.logs is
  // updated separately via pushLog for the in-TUI view.
  function emitLiveLog(state: RunState, level: LogEntry["level"], message: string) {
    if (!message || IGNORED_LIVE_LOG.test(message)) return
    emit({
      eventType: "live.log",
      algorithmId: state.algorithmId,
      payload: { runId: state.id, level, message, brokerage: state.brokerKind, mode: state.mode },
    })
  }

  const DEFAULT_ORDER_WHY = "Strategy submitted order without explicit reason"

  type NativeContext = Pick<Run, "id" | "algorithmId" | "algorithmName" | "symbol" | "interval" | "brokerKind" | "mode">

  function orderEventType(status: unknown): NativeHedgeLiveEventType {
    const normalized = typeof status === "string" ? status.toLowerCase() : ""
    if (normalized.includes("reject")) return "order.rejected"
    if (normalized === "filled" || normalized === "fully_filled") return "order.filled"
    return "order.submitted"
  }

  function nativeBase(state: NativeContext, msg: Record<string, any>): Omit<NativeHedgeLiveEventInput, "eventType"> {
    return {
      runId: state.id,
      algorithmId: state.algorithmId,
      algorithmName: state.algorithmName,
      symbol: typeof msg.symbol === "string" ? msg.symbol : state.symbol,
      interval: typeof msg.interval === "string" ? msg.interval : state.interval,
      brokerage: typeof msg.brokerage === "string" ? msg.brokerage : state.brokerKind,
      mode: typeof msg.mode === "string" ? msg.mode : state.mode,
    }
  }

  function nativeOrderFields(msg: Record<string, any>) {
    return {
      orderId:
        typeof msg.order_id === "string" ? msg.order_id : typeof msg.orderId === "string" ? msg.orderId : undefined,
      side: typeof msg.side === "string" ? msg.side : undefined,
      qty: typeof msg.qty === "number" ? msg.qty : undefined,
      price: typeof msg.price === "number" ? msg.price : undefined,
      status: typeof msg.status === "string" ? msg.status : undefined,
      why: typeof msg.reason === "string" && msg.reason.trim().length > 0 ? msg.reason : DEFAULT_ORDER_WHY,
      features: msg.features,
    }
  }

  function nativeEventsForMessage(state: NativeContext, msg: Record<string, any>): NativeHedgeLiveEventInput[] {
    const base = nativeBase(state, msg)
    switch (msg.type) {
      case "init":
        return [
          {
            ...base,
            eventType: "run.started",
            payload: {
              cash: msg.cash,
              equity: msg.equity,
            },
          },
        ]
      case "bar":
        return [{ ...base, eventType: "bar.seen", payload: msg }]
      case "order_intent": {
        const fields = nativeOrderFields(msg)
        return [
          {
            ...base,
            eventType: "decision.made",
            side: fields.side,
            qty: fields.qty,
            why: fields.why,
            features: fields.features,
            payload: { action: fields.side, ...msg },
          },
          {
            ...base,
            ...fields,
            eventType: "order.intent",
            payload: msg,
          },
        ]
      }
      case "order": {
        const fields = nativeOrderFields(msg)
        return [
          {
            ...base,
            ...fields,
            eventType: orderEventType(msg.status),
            payload: msg,
          },
        ]
      }
      case "equity":
        return [
          { ...base, eventType: "equity.snapshot", payload: { cash: msg.cash, equity: msg.equity } },
          { ...base, eventType: "position.snapshot", payload: { positions: msg.positions } },
        ]
      case "log":
        if (!msg.message || IGNORED_LIVE_LOG.test(String(msg.message))) return []
        return [
          { ...base, eventType: "log", status: typeof msg.level === "string" ? msg.level : undefined, payload: msg },
        ]
      case "error":
        return [{ ...base, eventType: "log", status: "error", payload: msg }]
      case "stop":
        return [
          {
            ...base,
            eventType: "run.stopped",
            status: typeof msg.reason === "string" ? msg.reason : undefined,
            payload: msg,
          },
        ]
      default:
        return []
    }
  }

  function recordNative(state: RunState, msg: Record<string, any>) {
    for (const event of nativeEventsForMessage(state, msg)) recordNativeEvent(state, event)
  }

  function recordNativeEvent(state: RunState, event: NativeHedgeLiveEventInput) {
    if (event.eventType === "run.stopped") {
      if (state.nativeStopRecorded) return
      state.nativeStopRecorded = true
    }
    NativeHedgeLedger.record(event)
  }

  function recordNativeStop(state: RunState, status: string, payload: Record<string, unknown>) {
    recordNativeEvent(state, {
      runId: state.id,
      algorithmId: state.algorithmId,
      algorithmName: state.algorithmName,
      symbol: state.symbol,
      interval: state.interval,
      brokerage: state.brokerKind,
      mode: state.mode,
      eventType: "run.stopped",
      status,
      payload,
    })
  }

  async function drainNativeLedger() {
    await NativeHedgeLedger.drain().catch((error) => {
      log.warn("native hedge ledger drain failed", { error })
    })
  }

  export function nativeEventsForMessageForTests(state: NativeContext, msg: Record<string, any>) {
    return nativeEventsForMessage(state, msg)
  }

  const LIVE_WORKER_PY = String.raw`import sys, os, json, time, signal, traceback, zlib
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from finny_broker import load_strategy, emit, log_err


def _default_ibkr_client_id(run_id: str) -> int:
    if not run_id or run_id == "unknown":
        return 1
    return 1000 + (zlib.crc32(run_id.encode("utf-8")) % 9000)


class _OrderLoggingBroker:
    """Transparent proxy around the real broker that emits an order event for
    every buy/sell the strategy places (including rejections), so fills surface
    in the run log and over SSE. Every other call passes straight through."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        # Only reached for attributes not defined on this proxy (equity, cash,
        # position, fetch_bar, market_is_open, set_price, ...).
        return getattr(self._inner, name)

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        self._intent("buy", symbol, qty=qty, notional=notional, reason=reason, features=features)
        return self._record(self._inner.buy(symbol, qty=qty, notional=notional, reason=reason, features=features), reason, features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        self._intent("sell", symbol, qty=qty, notional=notional, reason=reason, features=features)
        return self._record(self._inner.sell(symbol, qty=qty, notional=notional, reason=reason, features=features), reason, features)

    def _intent(self, side, symbol, qty=None, notional=None, reason=None, features=None):
        try:
            payload = {
                "type": "order_intent",
                "side": side,
                "symbol": symbol,
                "qty": qty if qty is not None else 0,
                "notional": notional,
                "reason": reason,
                "features": features,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
            emit(payload)
        except Exception as e:
            log_err("order intent emit failed: {}".format(e))

    def _record(self, rec, reason=None, features=None):
        try:
            if rec is not None and hasattr(rec, "to_dict"):
                data = rec.to_dict()
                if "reason" not in data and reason is not None:
                    data["reason"] = reason
                if "features" not in data and features is not None:
                    data["features"] = features
                emit({"type": "order", **data})
        except Exception as e:
            log_err("order emit failed: {}".format(e))
        return rec


def make_broker(kind: str, run_id: str):
    if kind == "alpaca":
        from finny_broker import AlpacaBroker
        key_id = os.environ.get("ALPACA_API_KEY_ID")
        secret = os.environ.get("ALPACA_API_SECRET_KEY")
        if not key_id or not secret:
            raise RuntimeError("Missing ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY")
        # ALPACA_MODE is the canonical env var emitted by alpacaSpec.envVars().
        # 'paper' (default) or 'live'.
        paper = os.environ.get("ALPACA_MODE", "paper").lower() != "live"
        endpoint = os.environ.get("ALPACA_ENDPOINT")
        return AlpacaBroker(key_id=key_id, secret=secret, paper=paper, endpoint=endpoint), "Alpaca paper" if paper else "Alpaca LIVE"
    if kind == "binance":
        from finny_broker import BinanceBroker
        api_key = os.environ.get("BINANCE_API_KEY")
        secret = os.environ.get("BINANCE_API_SECRET")
        if not api_key or not secret:
            raise RuntimeError("Missing BINANCE_API_KEY or BINANCE_API_SECRET")
        # BINANCE_MODE is the canonical env var; BINANCE_TESTNET is the legacy
        # 0/1 flag still emitted by the spec for backwards compat.
        testnet = os.environ.get("BINANCE_MODE", "testnet").lower() != "live"
        endpoint = os.environ.get("BINANCE_ENDPOINT")
        return BinanceBroker(api_key=api_key, secret=secret, testnet=testnet, endpoint=endpoint), "Binance testnet" if testnet else "Binance LIVE"
    if kind == "ibkr":
        from finny_broker import IBKRBroker
        account_id = os.environ.get("IBKR_ACCOUNT_ID")
        host = os.environ.get("IBKR_HOST", "127.0.0.1")
        mode = os.environ.get("IBKR_MODE", "paper").lower()
        if mode not in ("paper", "live"):
            raise RuntimeError(f"IBKR_MODE must be 'paper' or 'live', got {mode!r}")
        connection_app = os.environ.get("IBKR_CONNECTION_APP", "tws").lower()
        if connection_app not in ("tws", "gateway"):
            raise RuntimeError(f"IBKR_CONNECTION_APP must be 'tws' or 'gateway', got {connection_app!r}")
        if connection_app == "gateway":
            default_port = "4001" if mode == "live" else "4002"
        else:
            default_port = "7496" if mode == "live" else "7497"
        port_str = os.environ.get("IBKR_PORT", default_port)
        client_id_str = os.environ.get("IBKR_CLIENT_ID")
        if not account_id:
            raise RuntimeError("Missing IBKR_ACCOUNT_ID — add an IBKR account in Settings → Brokerages.")
        try:
            port = int(port_str)
        except ValueError:
            raise RuntimeError(f"IBKR_PORT must be an integer, got {port_str!r}")
        if client_id_str:
            try:
                client_id = int(client_id_str)
            except ValueError:
                raise RuntimeError(f"IBKR_CLIENT_ID must be an integer, got {client_id_str!r}")
        else:
            client_id = _default_ibkr_client_id(run_id)
        broker = IBKRBroker(account_id=account_id, host=host, port=port, client_id=client_id)
        connection_label = "IB Gateway" if connection_app == "gateway" else "TWS"
        return broker, f"IBKR {connection_label} {'paper' if mode != 'live' else 'LIVE'}"
    raise RuntimeError(f"Unknown broker kind: {kind}")


def main():
    broker_kind = os.environ.get("FINNY_BROKER_KIND", "alpaca")

    with open(Path(__file__).parent / "config.json") as f:
        config = json.load(f)

    symbol = config.get("symbol", "AAPL")
    interval = config.get("interval", "1min")
    run_id = config.get("run_id", "unknown")

    poll_map = {
        "1min": 30, "5min": 60, "15min": 90, "30min": 120,
        "1h": 180, "4h": 600, "1d": 900,
    }
    poll_seconds = poll_map.get(interval, 60)

    try:
        broker, broker_label = make_broker(broker_kind, run_id)
    except Exception as e:
        emit({"type": "error", "message": f"Connect to {broker_kind} failed: {e}"})
        sys.exit(2)

    # Wrap so every strategy buy/sell is logged as an order event.
    broker = _OrderLoggingBroker(broker)

    try:
        cash_start = broker.cash()
        eq_start = broker.equity()
    except Exception as e:
        emit({"type": "error", "message": f"Account fetch failed: {e}"})
        sys.exit(3)

    emit({"type": "init", "run_id": run_id, "symbol": symbol, "interval": interval,
          "broker_kind": broker_kind, "cash": cash_start, "equity": eq_start})
    emit({"type": "log", "level": "info",
          "message": "Connected to {}. Cash: {:,.2f} Equity: {:,.2f}".format(broker_label, cash_start, eq_start)})

    strategy_path = Path(__file__).parent / "strategy.py"
    try:
        step = load_strategy(strategy_path, broker)
    except Exception as e:
        emit({"type": "error", "message": f"Strategy load failed: {e}"})
        sys.exit(4)

    emit({"type": "log", "level": "info", "message": f"Polling {symbol} every {poll_seconds}s"})

    stopped = {"value": False}
    def handle_stop(signum, frame):
        stopped["value"] = True
        emit({"type": "log", "level": "info", "message": "Stop signal received"})
    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    last_ts = None
    prev_bar = None

    while not stopped["value"]:
        try:
            if not broker.market_is_open(symbol):
                emit({"type": "log", "level": "info", "message": "Market closed, sleeping 5m"})
                _sleep(300, stopped)
                continue

            bar = broker.fetch_bar(symbol, interval)
            if bar is None:
                emit({"type": "log", "level": "warn", "message": "No bar data yet"})
                _sleep(poll_seconds, stopped)
                continue

            if bar["timestamp"] == last_ts:
                _sleep(poll_seconds, stopped)
                continue
            last_ts = bar["timestamp"]

            emit({"type": "bar", "symbol": symbol, **bar})
            if prev_bar is None:
                prev_bar = bar
                emit({"type": "log", "level": "info", "message": "Stored first completed bar; waiting for prior-bar context before strategy decision"})
                _sleep(poll_seconds, stopped)
                continue

            decision_bar = {
                "timestamp": bar["timestamp"],
                "symbol": symbol,
                "open": bar["open"],
                "prev_open": prev_bar["open"],
                "prev_high": prev_bar["high"],
                "prev_low": prev_bar["low"],
                "prev_close": prev_bar["close"],
                "volume": bar["volume"],
            }
            try:
                broker.set_price(symbol, decision_bar["open"])
            except AttributeError:
                pass

            try:
                step(symbol, decision_bar)
            except Exception as e:
                emit({"type": "error", "message": f"Strategy error: {e}",
                      "trace": traceback.format_exc()})

            try:
                cash = broker.cash()
                eq = broker.equity()
                pos = broker.position(symbol)
                emit({"type": "equity", "cash": cash, "equity": eq, "positions": {symbol: pos}})
            except Exception as e:
                emit({"type": "log", "level": "warn", "message": f"Account refresh failed: {e}"})

            prev_bar = bar
            _sleep(poll_seconds, stopped)

        except Exception as e:
            emit({"type": "error", "message": f"Loop error: {e}",
                  "trace": traceback.format_exc()})
            _sleep(poll_seconds, stopped)

    try:
        pos = broker.position(symbol)
        if pos != 0:
            emit({"type": "log", "level": "warn",
                  "message": f"⚠ You have {pos} open {symbol} position(s). They remain at the broker. Close manually if needed."})
    except Exception:
        pass

    emit({"type": "stop", "reason": "user_requested"})


def _sleep(seconds, stopped):
    for _ in range(int(seconds)):
        if stopped["value"]:
            break
        time.sleep(1)


if __name__ == "__main__":
    main()
`

  export async function start(params: StartParams): Promise<Run> {
    await License.ensureActive()

    if (params.algorithm.backtestCode && params.algorithm.backtestCode.trim().length > 0) {
      throw new StartRejectedError(
        "Live trading is blocked for algorithms with custom backtestCode. Migrate to the strict Strategy(broker, params=None) contract.",
      )
    }
    const target = resolveStartTarget(params)
    const brokerKind = target.brokerKind
    const symbol = target.symbol

    const validation = await Validate.run(params.algorithm.code, {
      config: {
        symbol,
      },
    })
    if (!validation.valid) {
      throw new StartRejectedError(`Strategy validation failed before live start.\n${Validate.format(validation)}`)
    }
    // Prevent duplicate workers for the same deployment while allowing the
    // same algorithm to trade several distinct markets/accounts concurrently.
    for (const existing of runs.values()) {
      if (isActiveDeploymentConflict(existing, {
        algorithmId: params.algorithm.algorithmId,
        accountProviderID: params.accountProviderID,
        symbol,
      })) {
        throw new StartRejectedError(
          `"${params.algorithm.name}" is already running ${symbol} on this account. Stop it before starting a duplicate run.`,
        )
      }
    }

    // Tier gate for live trading on this brokerage. Paper trading bypasses
    // this check entirely — it never enters this code path.
    await requireBrokerTier(brokerKind)

    const spec = BrokerRegistry.getSpec(brokerKind)

    // Fast pre-check: credentials must be present before we promise a run.
    const creds = await BrokerRegistry.readCredentials(params.accountProviderID)
    if (!creds) {
      throw new StartRejectedError(
        `${spec.displayName} credentials not found. Open Settings → Paper Trading and connect your ${spec.displayName} account first.`,
      )
    }
    const disabledReason = liveTradingDisabledReason(spec, creds)
    if (disabledReason) throw new StartRejectedError(disabledReason)

    const id = crypto.randomUUID()

    // Resolve account label and mode (paper/testnet/live) for display.
    const accounts = await BrokerRegistry.listAccounts(brokerKind)
    const account = accounts.find((a) => a.providerID === params.accountProviderID)
    const accountLabel = account?.label
    const accountMode = account?.mode ?? creds.mode ?? spec.mode

    // Promotion is bound to one explicit immutable run and its matching
    // approval sidecar. Historical/legacy runs stay readable, but cannot pass
    // this hash-complete gate.
    const promotion = await verifyPromotion({
      algorithm: params.algorithm,
      runId: params.runId,
      symbol,
      mode: accountMode,
      controllerApproval: params.controllerApproval,
    })
    const eligibility = promotion.status
    const isLiveMoney = accountMode === "live"
    if (!promotion.ok || !canStartForMode(eligibility, accountMode)) {
      const need = isLiveMoney ? "a separate live_eligible record" : "a matching paper approval record"
      throw new StartRejectedError(
        `${isLiveMoney ? "Live" : "Paper"} trading is blocked for run ${params.runId} until it has ${need}. ${promotion.errors.join("; ") || `Current eligibility: ${eligibility ?? "none"}`}.`,
      )
    }

    // Create an initial "starting" run state IMMEDIATELY so the caller can open
    // the live-run dialog right away. The slow setup (venv, pip, spawn) happens
    // asynchronously below; progress streams through the normal event channel.
    const preState: RunState = {
      id,
      algorithmId: params.algorithm.algorithmId,
      algorithmName: params.algorithm.name,
      backtestRunId: params.runId,
      symbol,
      interval: params.interval,
      brokerKind,
      accountProviderID: params.accountProviderID,
      accountLabel,
      mode: accountMode,
      directory: params.directory,
      status: "starting",
      startedAt: Date.now(),
      positions: {},
      orders: [],
      logs: [],
      proc: null as unknown as Process.Child, // attached later
      tmpDir: "",
      ledgerSeq: 0,
      listeners: new Set(),
    }
    runs.set(id, preState)
    pushLog(preState, "info", "Preparing live run…")
    if (NativeHedgeLedger.enabled()) {
      pushLog(preState, "info", `Native hedge ledger enabled. Spool: ${NativeHedgeLedger.spoolPathForRun(id)}`)
      NativeHedgeLedger.record({
        runId: preState.id,
        algorithmId: preState.algorithmId,
        algorithmName: preState.algorithmName,
        symbol: preState.symbol,
        interval: preState.interval,
        brokerage: preState.brokerKind,
        mode: preState.mode,
        eventType: "run.started",
        status: "starting",
        payload: { phase: "starting" },
      })
    } else if (NativeHedgeLedger.flagEnabled()) {
      pushLog(
        preState,
        "warn",
        `Native hedge ledger disabled: ${NativeHedgeLedger.disabledReason() ?? "missing configuration"}`,
      )
    }
    emitLedger(preState, { kind: "status", workerType: "start", status: "starting", reason: "start_requested" })
    notify(preState)

    // Kick off the async setup. Do NOT await — return the initial snapshot so
    // the UI can open the dialog and watch progress stream in.
    void (async () => {
      try {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `finny-live-${id.slice(0, 8)}-`))
        preState.tmpDir = tmpDir

        // Ensure the managed Python env (installs alpaca-py on first use).
        const env = await PythonEnv.ensure((msg) => {
          pushLog(preState, "info", msg)
          notify(preState)
        })

        pushLog(preState, "info", `Using python at ${env.python}`)
        notify(preState)

        await fs.writeFile(path.join(tmpDir, "finny_broker.py"), FINNY_BROKER_PY)
        await fs.writeFile(path.join(tmpDir, "strategy.py"), params.algorithm.code)
        await fs.writeFile(
          path.join(tmpDir, "config.json"),
          JSON.stringify(
            {
              symbol,
              interval: params.interval,
              run_id: id,
              broker_kind: brokerKind,
            },
            null,
            2,
          ),
        )
        await fs.writeFile(path.join(tmpDir, "live_worker.py"), LIVE_WORKER_PY)

        const proc = Process.spawn([env.python, "live_worker.py"], {
          cwd: tmpDir,
          env: {
            FINNY_BROKER_KIND: brokerKind,
            ...spec.envVars(creds),
          },
          stdout: "pipe",
          stderr: "pipe",
        })

        preState.proc = proc
        attachProcess(preState)
      } catch (e: any) {
        const msg = e?.message ?? "Failed to start live run"
        preState.status = "error"
        preState.error = msg
        preState.stoppedAt = Date.now()
        pushLog(preState, "error", msg)
        emitLedger(preState, { kind: "status", workerType: "setup", status: "error", reason: msg })
        recordNativeStop(preState, "setup_failed", { reason: "setup_failed", error: msg })
        await drainNativeLedger()
        notify(preState)
        if (preState.tmpDir) {
          await fs.rm(preState.tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    })()

    return snapshot(preState)
  }

  // Attach stdout/stderr listeners + exit handler to a live run whose proc
  // has just been spawned.
  function attachProcess(state: RunState): void {
    const proc = state.proc

    // Pipe stdout line-by-line, parse JSON events
    if (proc.stdout) {
      let buffer = ""
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          handleLine(state, trimmed)
        }
      })
    }

    // Capture stderr as raw warn logs
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (!text) return
        for (const line of text.split("\n")) {
          if (!line.trim()) continue
          const message = line.trim()
          pushLog(state, "warn", message)
          recordNative(state, { type: "log", level: "warn", message })
          emitLedger(state, { kind: "log", workerType: "stderr", log: { level: "warn", message } })
          notify(state)
        }
      })
    }

    proc.exited
      .then(async (code) => {
        state.status = code === 0 ? "stopped" : "error"
        state.stoppedAt = Date.now()
        if (code !== 0) state.error = state.error ?? `Process exited with code ${code}`
        pushLog(state, code === 0 ? "info" : "error", `Process exited (code ${code})`)
        emit({
          eventType: "live.stopped",
          algorithmId: state.algorithmId,
          payload: { runId: state.id, reason: code === 0 ? "clean_exit" : `exit_code_${code}` },
        })
        emitLedger(state, {
          kind: "status",
          workerType: "exit",
          status: state.status,
          reason: code === 0 ? "clean_exit" : `exit_code_${code}`,
        })
        recordNativeStop(state, code === 0 ? "clean_exit" : `exit_code_${code}`, {
          reason: code === 0 ? "clean_exit" : `exit_code_${code}`,
          error: state.error,
        })
        await drainNativeLedger()
        notify(state)
      })
      .catch(async (err) => {
        state.status = "error"
        state.stoppedAt = Date.now()
        state.error = String(err?.message ?? err)
        pushLog(state, "error", state.error)
        emit({
          eventType: "live.stopped",
          algorithmId: state.algorithmId,
          payload: { runId: state.id, reason: "crash" },
        })
        emitLedger(state, { kind: "status", workerType: "exit", status: "error", reason: state.error })
        recordNativeStop(state, "crash", { reason: "crash", error: state.error })
        await drainNativeLedger()
        notify(state)
      })
  }

  function handleLine(state: RunState, line: string) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Not JSON — treat as a plain log line.
      pushLog(state, "info", line)
      emitLiveLog(state, "info", line)
      recordNative(state, { type: "log", level: "info", message: line })
      notify(state)
      return
    }

    recordNative(state, msg)

    switch (msg.type) {
      case "init": {
        state.status = "running"
        if (typeof msg.cash === "number") state.cash = msg.cash
        if (typeof msg.equity === "number") state.equity = msg.equity
        pushLog(state, "info", `Init: ${msg.symbol} · ${msg.interval}`)
        emit({
          eventType: "live.started",
          algorithmId: state.algorithmId,
          payload: {
            runId: state.id,
            symbol: msg.symbol,
            interval: msg.interval,
            cash: msg.cash,
            equity: msg.equity,
            brokerage: state.brokerKind,
            mode: state.mode,
          },
        })
        emitLedger(state, {
          kind: "status",
          workerType: "init",
          status: "running",
          symbol: msg.symbol,
          interval: msg.interval,
          mark: { cash: msg.cash, equity: msg.equity },
        })
        break
      }
      case "bar": {
        state.lastBar = {
          timestamp: msg.timestamp,
          open: msg.open,
          high: msg.high,
          low: msg.low,
          close: msg.close,
          volume: msg.volume,
        }
        emitLedger(state, { kind: "mark", workerType: "bar", symbol: msg.symbol, mark: state.lastBar })
        break
      }
      case "equity": {
        state.cash = msg.cash
        state.equity = msg.equity
        if (msg.positions) state.positions = { ...msg.positions }
        emit({
          eventType: "live.equity_snapshot",
          algorithmId: state.algorithmId,
          payload: { runId: state.id, cash: msg.cash, equity: msg.equity, positions: msg.positions },
        })
        emitLedger(state, {
          kind: "mark",
          workerType: "equity",
          mark: { cash: msg.cash, equity: msg.equity, positions: msg.positions },
        })
        break
      }
      case "order": {
        state.orders.push(msg as OrderEvent)
        if (state.orders.length > 200) state.orders.splice(0, state.orders.length - 200)
        pushLog(state, "info", `${msg.side} ${msg.qty} ${msg.symbol} @ ${msg.price} (${msg.status})`)
        emit({
          eventType: "live.order_fill",
          algorithmId: state.algorithmId,
          payload: {
            runId: state.id,
            side: msg.side,
            qty: msg.qty,
            symbol: msg.symbol,
            price: msg.price,
            status: msg.status,
          },
        })
        if (isExecutedOrder(msg.status)) {
          emitLedger(state, { kind: "fill", workerType: "order", symbol: msg.symbol, order: msg })
        }
        break
      }
      case "order_intent": {
        break
      }
      case "log": {
        const level = (msg.level as LogEntry["level"]) ?? "info"
        const message = msg.message ?? ""
        pushLog(state, level, message)
        emitLiveLog(state, level, message)
        if (level !== "info") emitLedger(state, { kind: "log", workerType: "log", log: { level, message } })
        break
      }
      case "error": {
        state.error = msg.message
        const message = msg.message ?? "unknown error"
        pushLog(state, "error", message)
        emitLiveLog(state, "error", message)
        emitLedger(state, { kind: "log", workerType: "error", log: { level: "error", message } })
        break
      }
      case "stop": {
        pushLog(state, "info", `Stop: ${msg.reason ?? "unknown"}`)
        emit({
          eventType: "live.stopped",
          algorithmId: state.algorithmId,
          payload: { runId: state.id, reason: msg.reason },
        })
        emitLedger(state, { kind: "status", workerType: "stop", status: "stopped", reason: msg.reason })
        break
      }
      default: {
        pushLog(state, "info", line)
        emitLiveLog(state, "info", line)
      }
    }
    notify(state)
  }

  export async function stop(id: string): Promise<void> {
    const state = runs.get(id)
    if (!state) return
    pushLog(state, "info", "Stopping…")
    notify(state)
    try {
      await Process.stop(state.proc)
    } catch (e) {
      log.warn("stop failed", { id, error: e })
    } finally {
      await drainNativeLedger()
    }
    // Clean up temp dir after process exits
    state.proc.exited
      .finally(async () => {
        await fs.rm(state.tmpDir, { recursive: true, force: true }).catch(() => {})
      })
      .catch(() => {})
  }

  /**
   * Synchronously signal every live worker child to terminate. Safe to call
   * from a process `exit`/signal handler (no awaits, no promises) — the daemon
   * uses this on shutdown so workers don't keep submitting orders after the
   * daemon (and its registry/UI stop path) goes away. The Python worker handles
   * SIGTERM gracefully, closing broker connections on the way out.
   */
  export function killAllSync(): void {
    for (const state of runs.values()) {
      try {
        state.proc.kill("SIGTERM")
      } catch {
        // best effort — proc may already be gone
      }
    }
  }

  export function list(): Run[] {
    return Array.from(runs.values()).map(snapshot)
  }

  export function get(id: string): Run | undefined {
    const state = runs.get(id)
    return state ? snapshot(state) : undefined
  }

  export function subscribe(id: string, handler: (run: Run) => void): () => void {
    const state = runs.get(id)
    if (!state) return () => {}
    state.listeners.add(handler)
    handler(snapshot(state))
    return () => {
      state.listeners.delete(handler)
    }
  }

  export function subscribeAll(handler: (runs: Run[]) => void): () => void {
    globalListeners.add(handler)
    handler(list())
    return () => {
      globalListeners.delete(handler)
    }
  }

  export function remove(id: string): boolean {
    const state = runs.get(id)
    if (!state || !canRemoveStatus(state.status)) return false
    const removed = runs.delete(id)
    if (removed) notifyAll()
    return removed
  }

}
