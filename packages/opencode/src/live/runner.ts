import fs from "fs/promises"
import os from "os"
import path from "path"
import crypto from "crypto"
import { Process } from "@/util/process"
import { Log } from "@/util/log"
import type { Algorithm } from "@/algorithm"
import { FINNY_BROKER_PY } from "@/backtest/broker-py"
import { PythonEnv } from "./python-env"
import { BrokerRegistry, type BrokerKind } from "./brokers"
import { Plan } from "@/plan"

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
    symbol: string
    interval: string
    brokerKind: BrokerKind
    accountProviderID: string
    accountLabel?: string
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
    symbol: string
    interval: string
    accountProviderID: string
    brokerKind?: BrokerKind
  }

  type RunState = Run & {
    proc: Process.Child
    tmpDir: string
    listeners: Set<(run: Run) => void>
  }

  const runs = new Map<string, RunState>()
  const globalListeners = new Set<(runs: Run[]) => void>()

  function snapshot(state: RunState): Run {
    const { proc: _p, tmpDir: _t, listeners: _l, ...rest } = state
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

  const LIVE_WORKER_PY = String.raw`import sys, os, json, time, signal, traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from finny_broker import load_strategy, emit, log_err


def make_broker(kind: str):
    if kind == "alpaca":
        from finny_broker import AlpacaBroker
        key_id = os.environ.get("ALPACA_API_KEY_ID")
        secret = os.environ.get("ALPACA_API_SECRET_KEY")
        if not key_id or not secret:
            raise RuntimeError("Missing ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY")
        paper = os.environ.get("ALPACA_PAPER", "1") not in ("0", "false", "False")
        return AlpacaBroker(key_id=key_id, secret=secret, paper=paper), "Alpaca paper" if paper else "Alpaca LIVE"
    if kind == "binance":
        from finny_broker import BinanceBroker
        api_key = os.environ.get("BINANCE_API_KEY")
        secret = os.environ.get("BINANCE_API_SECRET")
        if not api_key or not secret:
            raise RuntimeError("Missing BINANCE_API_KEY or BINANCE_API_SECRET")
        testnet = os.environ.get("BINANCE_TESTNET", "1") not in ("0", "false", "False")
        return BinanceBroker(api_key=api_key, secret=secret, testnet=testnet), "Binance testnet" if testnet else "Binance LIVE"
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
        broker, broker_label = make_broker(broker_kind)
    except Exception as e:
        emit({"type": "error", "message": f"Connect to {broker_kind} failed: {e}"})
        sys.exit(2)

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
            try:
                broker.set_price(symbol, bar["close"])
            except AttributeError:
                pass

            try:
                step(symbol, bar)
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
    // Free plan: limit to 1 simultaneous live algo.
    const activeCount = [...runs.values()].filter((r) => r.status === "starting" || r.status === "running").length
    if (activeCount >= 1 && !(await Plan.isPro())) {
      throw new Error("Free plan allows 1 simultaneous live algo. Upgrade to Finny Pro for unlimited. (Settings → Pro)")
    }

    // Prevent duplicate: only one active run per algorithm.
    for (const existing of runs.values()) {
      if (
        existing.algorithmId === params.algorithm.algorithmId &&
        (existing.status === "running" || existing.status === "starting")
      ) {
        throw new Error(`"${params.algorithm.name}" is already running. Stop it before starting a new run.`)
      }
    }

    // Resolve broker kind from explicit param or providerID prefix.
    const brokerKind: BrokerKind =
      params.brokerKind ?? BrokerRegistry.detectKind(params.accountProviderID) ?? "alpaca"
    const spec = BrokerRegistry.getSpec(brokerKind)

    // Fast pre-check: credentials must be present before we promise a run.
    const creds = await BrokerRegistry.readCredentials(params.accountProviderID)
    if (!creds) {
      throw new Error(
        `${spec.displayName} credentials not found. Open Settings → Paper Trading and connect your ${spec.displayName} account first.`,
      )
    }

    const id = crypto.randomUUID()

    // Resolve account label for display.
    const accounts = await BrokerRegistry.listAccounts(brokerKind)
    const accountLabel = accounts.find((a) => a.providerID === params.accountProviderID)?.label

    // Create an initial "starting" run state IMMEDIATELY so the caller can open
    // the live-run dialog right away. The slow setup (venv, pip, spawn) happens
    // asynchronously below; progress streams through the normal event channel.
    const preState: RunState = {
      id,
      algorithmId: params.algorithm.algorithmId,
      algorithmName: params.algorithm.name,
      symbol: params.symbol,
      interval: params.interval,
      brokerKind,
      accountProviderID: params.accountProviderID,
      accountLabel,
      status: "starting",
      startedAt: Date.now(),
      positions: {},
      orders: [],
      logs: [],
      proc: null as unknown as Process.Child, // attached later
      tmpDir: "",
      listeners: new Set(),
    }
    runs.set(id, preState)
    pushLog(preState, "info", "Preparing live run…")
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
              symbol: params.symbol,
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
          pushLog(state, "warn", line.trim())
          notify(state)
        }
      })
    }

    proc.exited
      .then((code) => {
        state.status = code === 0 ? "stopped" : "error"
        state.stoppedAt = Date.now()
        if (code !== 0) state.error = state.error ?? `Process exited with code ${code}`
        pushLog(state, code === 0 ? "info" : "error", `Process exited (code ${code})`)
        notify(state)
      })
      .catch((err) => {
        state.status = "error"
        state.stoppedAt = Date.now()
        state.error = String(err?.message ?? err)
        pushLog(state, "error", state.error)
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
      notify(state)
      return
    }

    switch (msg.type) {
      case "init": {
        state.status = "running"
        if (typeof msg.cash === "number") state.cash = msg.cash
        if (typeof msg.equity === "number") state.equity = msg.equity
        pushLog(state, "info", `Init: ${msg.symbol} · ${msg.interval}`)
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
        break
      }
      case "equity": {
        state.cash = msg.cash
        state.equity = msg.equity
        if (msg.positions) state.positions = { ...msg.positions }
        break
      }
      case "order": {
        state.orders.push(msg as OrderEvent)
        if (state.orders.length > 200) state.orders.splice(0, state.orders.length - 200)
        pushLog(state, "info", `${msg.side} ${msg.qty} ${msg.symbol} @ ${msg.price} (${msg.status})`)
        break
      }
      case "log": {
        pushLog(state, (msg.level as LogEntry["level"]) ?? "info", msg.message ?? "")
        break
      }
      case "error": {
        state.error = msg.message
        pushLog(state, "error", msg.message ?? "unknown error")
        break
      }
      case "stop": {
        pushLog(state, "info", `Stop: ${msg.reason ?? "unknown"}`)
        break
      }
      default: {
        pushLog(state, "info", line)
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
    }
    // Clean up temp dir after process exits
    state.proc.exited
      .finally(async () => {
        await fs.rm(state.tmpDir, { recursive: true, force: true }).catch(() => {})
      })
      .catch(() => {})
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

  export function remove(id: string) {
    runs.delete(id)
  }
}
