import crypto from "node:crypto"
import { McpRobinhood } from "@/mcp/robinhood"
import { Log } from "@/util/log"

const log = Log.create({ service: "live.robinhood-bridge" })

export interface Bridge {
  readonly url: string
  readonly close: () => Promise<void>
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } })
}

function orderIntent(value: unknown, accountId: string): McpRobinhood.EquityOrderIntent {
  if (!value || typeof value !== "object") throw new Error("Order intent must be an object.")
  const input = value as Record<string, unknown>
  if (typeof input.intentId !== "string" || !/^[a-f0-9]{64}$/.test(input.intentId)) {
    throw new Error("Order intent id is invalid.")
  }
  if (typeof input.symbol !== "string" || !/^[A-Z]{1,5}$/.test(input.symbol)) {
    throw new Error("Order symbol is outside the Robinhood equity/ETF scope.")
  }
  if (input.side !== "buy" && input.side !== "sell") throw new Error("Order side is invalid.")
  if (typeof input.qty !== "number" || !Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error("Order quantity is invalid.")
  }
  return {
    intentId: input.intentId,
    accountId,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
  } as McpRobinhood.EquityOrderIntent
}

export function start(adapter: McpRobinhood.ExecutionAdapter, accountId: string): Bridge {
  const capability = crypto.randomBytes(32).toString("hex")
  const prefix = `/${capability}`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith(`${prefix}/`)) return json({ error: "not_found" }, 404)
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (!Number.isFinite(declaredLength) || declaredLength > 32_768) return json({ error: "payload_too_large" }, 413)
      try {
        const bytes = await request.arrayBuffer()
        if (bytes.byteLength > 32_768) return json({ error: "payload_too_large" }, 413)
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
        switch (url.pathname.slice(prefix.length)) {
          case "/snapshot":
            return json(await adapter.snapshot(accountId))
          case "/quote":
            if (typeof payload.symbol !== "string") throw new Error("Quote symbol is required.")
            return json(await adapter.quote(accountId, payload.symbol))
          case "/historicals": {
            if (typeof payload.symbol !== "string" || typeof payload.interval !== "string") {
              throw new Error("Historical symbol and interval are required.")
            }
            const bars = await adapter.historicalBars(accountId, payload.symbol, payload.interval)
            return json(bars.at(-1) ?? null)
          }
          case "/order": {
            return json(await adapter.reviewAndPlace(orderIntent(payload, accountId)))
          }
          case "/order-by-intent":
            if (typeof payload.intentId !== "string") throw new Error("Intent id is required.")
            return json((await adapter.orderByIntentId(accountId, payload.intentId)) ?? null)
          case "/cancel-open-orders":
            return json({ cancelled: await adapter.cancelOpenOrders(accountId) })
          default:
            return json({ error: "not_found" }, 404)
        }
      } catch (error) {
        log.error("broker operation failed", { error })
        return json({ error: "broker_operation_failed" }, 409)
      }
    },
  })
  let closed = false
  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    close: async () => {
      if (closed) return
      closed = true
      await server.stop(true)
    },
  }
}

export const ROBINHOOD_BRIDGE_BROKER_PY = String.raw`
class RobinhoodBridgeBroker(RobinhoodBroker):
    """Secret-free worker facade for the daemon-owned official MCP client."""

    def __init__(self, bridge_url, symbol):
        super().__init__(profile="official-mcp", command="disabled", symbol=symbol)
        if not isinstance(bridge_url, str) or not bridge_url.startswith("http://127.0.0.1:"):
            raise RuntimeError("Robinhood daemon bridge URL is invalid")
        self._bridge_url = bridge_url.rstrip("/")

    def _bridge(self, route, payload):
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self._bridge_url + route,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError("Robinhood daemon bridge operation failed") from exc
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(str(result["error"]))
        return result

    def execution_snapshot(self, symbol):
        result = self._bridge("/snapshot", {})
        return {
            "cash": float(result["cash"]),
            "equity": float(result["equity"]),
            "observed_at": result["observedAt"],
            "positions": result.get("positions") or {},
        }

    def cash(self):
        return self.execution_snapshot(self._active_symbol)["cash"]

    def equity(self):
        return self.execution_snapshot(self._active_symbol)["equity"]

    def position(self, symbol):
        value = self.execution_snapshot(symbol)["positions"].get(self.normalize_symbol(symbol)) or {}
        return float(value.get("qty", 0))

    def price(self, symbol):
        normalized = self.normalize_symbol(symbol)
        cached = self._last_price.get(normalized)
        if cached is not None:
            return cached
        return float(self._bridge("/quote", {"symbol": normalized})["price"])

    def market_is_open(self, symbol):
        # The official feed's finalized bars are the availability boundary.
        return True

    def fetch_bar(self, symbol, interval):
        result = self._bridge("/historicals", {
            "symbol": self.normalize_symbol(symbol),
            "interval": interval,
        })
        if result is None:
            return None
        return {
            "timestamp": result["barStart"],
            "bar_start": result["barStart"],
            "bar_end": result["barEnd"],
            "source_timestamp": result["sourceTimestamp"],
            "is_final": result["isFinal"],
            "session_id": result["sessionId"],
            "open": float(result["open"]),
            "high": float(result["high"]),
            "low": float(result["low"]),
            "close": float(result["close"]),
            "volume": float(result["volume"]),
        }

    def _submit(self, symbol, side, qty, notional, reason=None, features=None, client_order_id=None):
        if notional is not None or qty is None:
            raise RuntimeError("Robinhood v1 requires an explicit quantity")
        intent_id = client_order_id or (features or {}).get("intent_id")
        result = self._bridge("/order", {
            "intentId": intent_id,
            "symbol": self.normalize_symbol(symbol),
            "side": side,
            "qty": float(qty),
        })
        return OrderRecord(
            order_id=str(result["orderId"]), symbol=self.normalize_symbol(symbol), side=side,
            qty=float(qty), price=float(self.price(symbol)), status=str(result["status"]),
            ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
        )

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None, client_order_id=None):
        return self._submit(symbol, "buy", qty, notional, reason, features, client_order_id)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None, client_order_id=None):
        return self._submit(symbol, "sell", qty, notional, reason, features, client_order_id)

    def get_order_by_client_id(self, intent_id):
        result = self._bridge("/order-by-intent", {"intentId": intent_id})
        if result is None:
            return None
        return OrderRecord(
            order_id=str(result["orderId"]), symbol=str(result["symbol"]), side=str(result["side"]),
            qty=float(result["qty"]), price=0.0, status=str(result["status"]),
            ts=datetime.now(timezone.utc).isoformat(), features={"intent_id": intent_id},
        )

    def cancel_all_orders(self):
        return self._bridge("/cancel-open-orders", {})
`

export * as RobinhoodBridge from "./robinhood-bridge"
