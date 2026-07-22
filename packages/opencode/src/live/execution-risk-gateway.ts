import crypto from "node:crypto"
import path from "node:path"
import { resolveFinnyHome } from "@finny-ai/core/prefs"
import type { Mission } from "@/algorithm/mission"
import type { BrokerKind, BrokerMode } from "./brokers"

export const ORDER_INTENT_SCHEMA = "finny.order_intent" as const
export const EXECUTION_POLICY_SCHEMA = "finny.execution_policy" as const

export interface OrderIntentV1 {
  schema: typeof ORDER_INTENT_SCHEMA
  version: 1
  intent_id: string
  run_id: string
  run_identity_hash: string
  algorithm_id: string
  algorithm_version: number
  strategy_hash: string
  risk_policy_hash: string
  execution_policy_hash: string
  effective_config_hash: string
  account_scope_hash: string
  symbol: string
  asset_scope: string
  bar_watermark: string
  signal_timestamp: string
  side: "buy" | "sell"
  requested_qty: number | null
  requested_notional: number | null
  requested_risk: number | null
  stop_reference: number | null
  reason: string
}

export interface ExecutionPolicyV1 {
  schema: typeof EXECUTION_POLICY_SCHEMA
  version: 1
  riskContract: Mission.RiskContract
  /** Optional compatibility seam for #177. Missing limits keep submission fail-closed. */
  limits?: {
    maxGrossExposurePct: number
    maxNetExposurePct: number
    maxSymbolExposurePct: number
    maxAccountSnapshotAgeMs: number
    maxMarketDataAgeMs: number
    flattenOnStop: boolean
  }
  capabilities?: {
    marketOrders: boolean
    fractionalQty: boolean
    cancelAll: boolean
    positionSnapshot: boolean
  }
}

export interface ExecutionBindingV1 {
  runId: string
  runIdentityHash: string
  algorithmId: string
  algorithmVersion: number
  strategyHash: string
  riskPolicyHash: string
  executionPolicyHash: string
  effectiveConfigHash: string
  symbol: string
  interval: string
  brokerKind: BrokerKind
  brokerMode: BrokerMode
  accountScopeHash: string
}

export interface PaperExecutionContractV1 {
  schema: "finny.paper_execution_contract"
  version: 1
  binding: ExecutionBindingV1
  policy: ExecutionPolicyV1
  ledgerPath: string
  /** Deliberately hard-disabled until shadow/fault review is approved in a later issue. */
  submissionEnabled: false
}

export interface PaperActivationReceiptV1 {
  schema: "finny.paper_activation_receipt"
  version: 1
  /** Integration-layer run identity. The strict Finny run is bound separately below. */
  runId: string
  strictRunId: string
  strategyHash: string
  riskPolicyHash: string
  accountScopeHash: string
  approvedByDiscordUserId: string
  shadowProofHash: string
  activatedAt: string
  receiptHash: string
  signature: string
}

export interface PaperExecutionContractV2 {
  schema: "finny.paper_execution_contract"
  version: 2
  binding: ExecutionBindingV1
  policy: ExecutionPolicyV1
  ledgerPath: string
  submissionMode: "shadow" | "paper"
  activationReceipt?: PaperActivationReceiptV1
}

export type PaperExecutionContract = PaperExecutionContractV1 | PaperExecutionContractV2

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`
}

export function verifyPaperActivationReceipt(input: {
  receipt: PaperActivationReceiptV1 | undefined
  binding: ExecutionBindingV1
  secret: string | undefined
}): string[] {
  const { receipt, binding, secret } = input
  if (!receipt) return ["paper activation receipt is missing"]
  if (receipt.schema !== "finny.paper_activation_receipt" || receipt.version !== 1) {
    return ["paper activation receipt schema is invalid"]
  }
  const { receiptHash, signature, ...body } = receipt
  const expectedHash = crypto.createHash("sha256").update(canonical(body)).digest("hex")
  const expectedSignature = secret
    ? crypto.createHmac("sha256", secret).update(expectedHash).digest("hex")
    : undefined
  const errors: string[] = []
  if (!secret) errors.push("FINNY_PAPER_ACTIVATION_KEY is not configured")
  if (receiptHash !== expectedHash) errors.push("paper activation receipt hash mismatch")
  if (
    !expectedSignature ||
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    errors.push("paper activation receipt signature mismatch")
  }
  if (receipt.strictRunId !== binding.runId) errors.push("paper activation strict run mismatch")
  if (receipt.strategyHash !== binding.strategyHash) errors.push("paper activation strategy mismatch")
  if (receipt.riskPolicyHash !== binding.riskPolicyHash) errors.push("paper activation risk policy mismatch")
  if (receipt.accountScopeHash !== binding.accountScopeHash) errors.push("paper activation account mismatch")
  if (!receipt.approvedByDiscordUserId.trim()) errors.push("paper activation approver is missing")
  if (!/^[a-f0-9]{64}$/.test(receipt.shadowProofHash)) errors.push("paper activation shadow proof is invalid")
  if (!Number.isFinite(Date.parse(receipt.activatedAt))) errors.push("paper activation timestamp is invalid")
  return errors
}

export function accountScopeHash(input: { brokerKind: BrokerKind; accountProviderID: string }): string {
  return crypto.createHash("sha256").update(`${input.brokerKind}\0${input.accountProviderID}`).digest("hex")
}

export function executionLedgerPath(input: {
  algorithmId: string
  algorithmVersion: number
  accountScopeHash: string
  symbol: string
  env?: NodeJS.ProcessEnv
}): string {
  const deployment = crypto
    .createHash("sha256")
    .update(`${input.algorithmId}\0${input.algorithmVersion}\0${input.accountScopeHash}\0${input.symbol}`)
    .digest("hex")
  return path.join(resolveFinnyHome({ env: input.env }).path, "paper-execution-ledger", `${deployment}.jsonl`)
}

/** Python is written beside the worker so strategy code never receives the real broker. */
export const EXECUTION_RISK_GATEWAY_PY = String.raw`"""Fail-closed paper execution gateway shared with the strict engine risk formula."""
from __future__ import annotations

import hashlib
import json
import math
import os
from datetime import datetime, timezone


DECISION_CODES = {
    "accepted_shadow", "accepted_paper", "bar_not_final", "bar_out_of_order", "bar_stale",
    "binding_mismatch", "broker_capability", "duplicate_intent", "drawdown_halt",
    "account_currency_mismatch", "gross_exposure_limit", "net_exposure_limit", "symbol_exposure_limit",
    "invalid_intent", "max_positions", "policy_incomplete", "protective_stop_required",
    "risk_size_exceeded", "stale_account", "submission_disabled", "broker_rejected", "unresolved_divergence",
}


def _utc_now():
    return datetime.now(timezone.utc)


def _parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _finite_positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and float(value) > 0


class DurableExecutionLedger:
    """Append-only JSONL with fsync; replay ignores a torn final record and halts."""

    def __init__(self, path):
        self.path = path
        self.events = []
        self.torn = False
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            with open(path, "rb") as handle:
                lines = handle.read().splitlines()
            for index, line in enumerate(lines):
                if not line.strip():
                    continue
                try:
                    self.events.append(json.loads(line))
                except Exception:
                    self.torn = True
                    if index != len(lines) - 1:
                        raise RuntimeError("execution ledger contains interior corruption")

    def append(self, event):
        record = dict(event)
        record.setdefault("schema", "finny.execution_event")
        record.setdefault("version", 1)
        record.setdefault("recorded_at", _utc_now().isoformat())
        body = (_canonical(record) + "\n").encode("utf-8")
        with open(self.path, "ab", buffering=0) as handle:
            handle.write(body)
            os.fsync(handle.fileno())
        self.events.append(record)
        return record


class IntentRecord:
    def __init__(self, intent, decision):
        self.intent = intent
        self.decision = decision

    def to_dict(self):
        paper = self.decision.get("reason_code") == "accepted_paper"
        return {
            "order_id": self.decision.get("broker_order_id") or self.intent["intent_id"],
            "intent_id": self.intent["intent_id"],
            "symbol": self.intent["symbol"],
            "side": self.intent["side"],
            "qty": self.intent.get("requested_qty") or 0,
            "price": 0,
            "status": "submitted" if paper else ("shadow" if self.decision["accepted"] else "rejected: " + self.decision["reason_code"]),
            "ts": self.decision["decided_at"],
            "reason": self.intent.get("reason"),
            "features": None,
        }


class ExecutionRiskGateway:
    def __init__(self, contract, broker, emit):
        self.contract = contract
        self.binding = contract["binding"]
        self.policy = contract["policy"]
        self.computed_policy_hash = _hash(self.policy)
        self.broker = broker
        self.emit = emit
        self.ledger = DurableExecutionLedger(contract["ledgerPath"])
        self.current_bar = None
        self.account = None
        self.reservations = {}
        self.halted = self.ledger.torn or self.computed_policy_hash != self.binding.get("executionPolicyHash")
        self.high_water_equity = None
        self.known_outcomes = {
            event.get("intent_id") for event in self.ledger.events
            if event.get("event_type") == "decision" and event.get("intent_id")
        }
        pending = {
            event.get("intent_id") for event in self.ledger.events
            if event.get("event_type") == "intent" and event.get("intent_id")
        } - self.known_outcomes
        self.submission_mode = contract.get("submissionMode", "shadow")
        self.pending_intents = sorted(item for item in pending if isinstance(item, str))
        # Shadow mode has no broker side effect between intent and decision.
        if not self.ledger.torn and self.submission_mode == "shadow":
            for intent_id in sorted(pending):
                self.ledger.append({
                    "event_type": "decision", "intent_id": intent_id, "accepted": False,
                    "reason_code": "submission_disabled", "recovered": True,
                })
                self.known_outcomes.add(intent_id)
        watermarks = [event.get("watermark") for event in self.ledger.events if event.get("event_type") == "bar_advanced"]
        self.last_watermark = max((item for item in watermarks if isinstance(item, str)), default=None)
        snapshots = [event for event in self.ledger.events if event.get("event_type") == "broker_snapshot"]
        self.last_snapshot = snapshots[-1] if snapshots else None
        historical_equity = [
            float(event["equity"]) for event in snapshots if _finite_positive(event.get("equity"))
        ]
        self.historical_high_water_equity = max(historical_equity, default=None)

    def _append_emit(self, event):
        record = self.ledger.append(event)
        # Remote telemetry receives only the privacy-safe join keys and stable
        # decision state. The durable local ledger retains the full audit row.
        telemetry = {
            key: record[key] for key in (
                "event_type", "recorded_at", "intent_id", "accepted", "reason_code",
                "status", "watermark", "session_id", "recovered", "max_qty",
            ) if key in record
        }
        intent = record.get("intent")
        if isinstance(intent, dict):
            telemetry.update({
                "run_id": intent.get("run_id"), "risk_policy_hash": intent.get("risk_policy_hash"),
                "execution_policy_hash": intent.get("execution_policy_hash"),
                "effective_config_hash": intent.get("effective_config_hash"),
                "bar_watermark": intent.get("bar_watermark"), "side": intent.get("side"),
                "requested_qty": intent.get("requested_qty"), "requested_notional": intent.get("requested_notional"),
            })
        self.emit({"type": "execution_event", **telemetry})
        return record

    def _snapshot(self):
        observed = _utc_now().isoformat()
        raw = self.broker.execution_snapshot(self.binding["symbol"])
        cash = float(raw["cash"])
        equity = float(raw["equity"])
        positions = {}
        for key, value in raw["positions"].items():
            if not isinstance(value, dict):
                raise RuntimeError("broker execution snapshot position must include qty and mark")
            qty = float(value["qty"])
            mark = float(value["mark"])
            if not math.isfinite(qty) or not _finite_positive(mark):
                raise RuntimeError("broker returned an invalid execution position valuation")
            if qty != 0:
                positions[str(key)] = {"qty": qty, "mark": mark}
        if not math.isfinite(cash) or not _finite_positive(equity):
            raise RuntimeError("broker returned a non-finite or non-positive execution snapshot")
        return {"cash": cash, "equity": equity, "positions": positions, "observed_at": observed}

    def reconcile_start(self):
        if self.halted:
            # A torn ledger cannot be safely extended; preserve it for audit.
            return False
        try:
            current = self._snapshot()
        except Exception as exc:
            self.halted = True
            self._append_emit({"event_type": "reconciliation", "status": "halted", "reason_code": "stale_account", "detail": str(exc)})
            return False
        expected = self._position_quantities((self.last_snapshot or {}).get("positions", {}))
        observed = self._position_quantities(current["positions"])
        if self.last_snapshot is not None and expected != observed:
            self.halted = True
            self._append_emit({
                "event_type": "reconciliation", "status": "halted", "reason_code": "unresolved_divergence",
                "expected_positions": expected, "positions": observed,
            })
            return False
        self.account = current
        self.high_water_equity = max(self.historical_high_water_equity or current["equity"], current["equity"])
        self._append_emit({"event_type": "reconciliation", "status": "matched", "positions": current["positions"]})
        self._append_emit({"event_type": "broker_snapshot", **current})
        if self.submission_mode == "paper":
            for intent_id in self.pending_intents:
                try:
                    order = self.broker.get_order_by_client_id(intent_id)
                except Exception as exc:
                    self.halted = True
                    self._append_emit({"event_type": "reconciliation", "status": "halted", "reason_code": "unresolved_divergence", "intent_id": intent_id, "detail": str(exc)})
                    return False
                if order is None:
                    self.halted = True
                    self._append_emit({"event_type": "reconciliation", "status": "halted", "reason_code": "unresolved_divergence", "intent_id": intent_id})
                    return False
                self._append_emit({"event_type": "order_ack", "intent_id": intent_id, "broker_order_id": str(order.id), "status": str(order.status), "recovered": True})
                self._append_emit({"event_type": "decision", "intent_id": intent_id, "accepted": True, "reason_code": "accepted_paper", "broker_order_id": str(order.id), "recovered": True})
                self.known_outcomes.add(intent_id)
        return True

    def begin_bar(self, bar):
        reason = self._validate_bar(bar)
        if reason:
            self._append_emit({"event_type": "bar_rejected", "reason_code": reason, "watermark": bar.get("bar_end")})
            return False
        try:
            self.account = self._snapshot()
        except Exception as exc:
            self.halted = True
            self._append_emit({"event_type": "reconciliation", "status": "halted", "reason_code": "stale_account", "detail": str(exc)})
            return False
        self.high_water_equity = max(self.high_water_equity or self.account["equity"], self.account["equity"])
        if self._drawdown_breached():
            self.halted = True
            self._append_emit({"event_type": "halt", "reason_code": "drawdown_halt", "watermark": bar["bar_end"]})
            return False
        self.current_bar = dict(bar)
        self.reservations = {}
        self.last_watermark = bar["bar_end"]
        self._append_emit({
            "event_type": "bar_advanced",
            "watermark": self.last_watermark,
            "bar_start": bar["bar_start"],
            "bar_end": bar["bar_end"],
            "session_id": bar["session_id"],
        })
        return True

    @staticmethod
    def _position_quantities(positions):
        return {
            str(symbol): float(value.get("qty", 0))
            for symbol, value in positions.items() if isinstance(value, dict) and float(value.get("qty", 0)) != 0
        }

    def _validate_bar(self, bar):
        required = ("bar_start", "bar_end", "is_final", "session_id", "source_timestamp")
        if any(key not in bar for key in required) or bar.get("is_final") is not True:
            return "bar_not_final"
        end = _parse_time(bar.get("bar_end"))
        source = _parse_time(bar.get("source_timestamp"))
        if end is None or source is None:
            return "bar_not_final"
        if self.last_watermark is not None:
            previous = _parse_time(self.last_watermark)
            if previous is None or end <= previous:
                return "bar_out_of_order"
        limits = self.policy.get("limits")
        if limits and (_utc_now() - end).total_seconds() * 1000 > limits["maxMarketDataAgeMs"]:
            return "bar_stale"
        return None

    def _drawdown_breached(self):
        risk = self.policy["riskContract"]
        drawdown = risk["drawdown"]
        if drawdown["mode"] != "halt_and_flatten_next_open" or not self.high_water_equity:
            return False
        pct = (self.high_water_equity - self.account["equity"]) / self.high_water_equity * 100.0
        return pct >= float(drawdown["limit_pct"])

    def _make_intent(self, side, symbol, qty, notional, reason, features):
        binding = self.binding
        bar = self.current_bar or {}
        payload = {
            "schema": "finny.order_intent", "version": 1,
            "run_id": binding["runId"], "run_identity_hash": binding["runIdentityHash"],
            "algorithm_id": binding["algorithmId"], "algorithm_version": binding["algorithmVersion"],
            "strategy_hash": binding["strategyHash"], "risk_policy_hash": binding["riskPolicyHash"],
            "execution_policy_hash": binding["executionPolicyHash"],
            "effective_config_hash": binding["effectiveConfigHash"],
            "account_scope_hash": binding["accountScopeHash"], "symbol": symbol, "asset_scope": symbol,
            "bar_watermark": bar.get("bar_end"), "signal_timestamp": bar.get("source_timestamp"),
            "side": side, "requested_qty": qty, "requested_notional": notional,
            "requested_risk": (features or {}).get("requested_risk") if isinstance(features, dict) else None,
            "stop_reference": (features or {}).get("stop_reference") if isinstance(features, dict) else None,
            "reason": str(reason or "strategy_intent")[:500],
        }
        payload["intent_id"] = _hash(payload)
        return payload

    def submit_intent(self, side, symbol, qty=None, notional=None, reason=None, features=None):
        if self.current_bar is None:
            raise RuntimeError("strategy intents require a newly finalized bar")
        intent = self._make_intent(side, symbol, qty, notional, reason, features)
        self._append_emit({"event_type": "intent", "intent_id": intent["intent_id"], "intent": intent})
        decision = self._decide(intent)
        self._append_emit({"event_type": "decision", "intent_id": intent["intent_id"], **decision})
        self.known_outcomes.add(intent["intent_id"])
        self.emit({
            "type": "order_intent", "intent_id": intent["intent_id"], "run_id": intent["run_id"],
            "risk_policy_hash": intent["risk_policy_hash"], "bar_watermark": intent["bar_watermark"],
            "execution_policy_hash": intent["execution_policy_hash"],
            "effective_config_hash": intent["effective_config_hash"],
            "side": intent["side"], "qty": intent["requested_qty"], "notional": intent["requested_notional"],
            **decision,
        })
        record = IntentRecord(intent, decision)
        if decision.get("reason_code") == "accepted_paper":
            self.emit({"type": "order", **record.to_dict()})
        return record

    def _reject(self, reason):
        return {"accepted": False, "reason_code": reason, "decided_at": _utc_now().isoformat()}

    def _decide(self, intent):
        if intent["intent_id"] in self.known_outcomes:
            return self._reject("duplicate_intent")
        if self.halted:
            return self._reject("unresolved_divergence")
        if self.current_bar is None or intent["bar_watermark"] != self.last_watermark:
            return self._reject("bar_not_final")
        if _hash(self.policy) != self.binding.get("executionPolicyHash"):
            return self._reject("binding_mismatch")
        binding = self.binding
        checks = {
            "run_id": "runId", "run_identity_hash": "runIdentityHash", "algorithm_id": "algorithmId",
            "algorithm_version": "algorithmVersion", "strategy_hash": "strategyHash",
            "risk_policy_hash": "riskPolicyHash", "account_scope_hash": "accountScopeHash", "symbol": "symbol",
            "execution_policy_hash": "executionPolicyHash",
            "effective_config_hash": "effectiveConfigHash",
        }
        if any(intent[left] != binding[right] for left, right in checks.items()):
            return self._reject("binding_mismatch")
        if binding.get("brokerKind") == "binance":
            _, separator, quote = intent["symbol"].upper().replace("-", "/").rpartition("/")
            if not separator or quote != "USDT":
                return self._reject("account_currency_mismatch")
        if intent["side"] not in ("buy", "sell") or (intent["requested_qty"] is None) == (intent["requested_notional"] is None):
            return self._reject("invalid_intent")
        limits = self.policy.get("limits")
        capabilities = self.policy.get("capabilities")
        if not limits or not capabilities or not capabilities.get("marketOrders") or not capabilities.get("positionSnapshot"):
            return self._reject("policy_incomplete")
        observed = _parse_time((self.account or {}).get("observed_at"))
        if observed is None or (_utc_now() - observed).total_seconds() * 1000 > limits["maxAccountSnapshotAgeMs"]:
            return self._reject("stale_account")
        price = float(self.current_bar["open"])
        qty = intent["requested_qty"]
        if qty is None:
            qty = float(intent["requested_notional"]) / price
        if not _finite_positive(qty):
            return self._reject("invalid_intent")
        if not capabilities.get("fractionalQty") and not float(qty).is_integer():
            return self._reject("broker_capability")
        risk = self.policy["riskContract"]
        position = float((self.account["positions"].get(intent["symbol"]) or {}).get("qty", 0))
        position += float(self.reservations.get(intent["symbol"], 0))
        after = position + (float(qty) if intent["side"] == "buy" else -float(qty))
        side_flip = position * after < 0
        increases_exposure = side_flip or abs(after) > abs(position) + 1e-12
        if increases_exposure and risk["protective_stop"]["mode"] == "strategy_next_open" and not _finite_positive(intent.get("stop_reference")):
            return self._reject("protective_stop_required")
        stop_distance = price * float(risk["sizing_stop_distance_pct"]) / 100.0
        risk_budget = float(self.account["equity"]) * float(risk["drawdown"]["limit_pct"]) / 100.0 / int(risk["max_positions"])
        max_qty = risk_budget / stop_distance
        if increases_exposure and abs(after) > max_qty + 1e-12:
            return self._reject("risk_size_exceeded")
        current_open = sum(
            1 for symbol, value in self.account["positions"].items()
            if symbol != intent["symbol"] and float(value["qty"]) != 0
        ) + (1 if position != 0 else 0)
        if position == 0 and after != 0 and current_open >= int(risk["max_positions"]):
            return self._reject("max_positions")
        equity = float(self.account["equity"])
        notionals = {
            symbol: float(value["qty"]) * float(value["mark"])
            for symbol, value in self.account["positions"].items()
        }
        notionals[intent["symbol"]] = after * price
        symbol_pct = abs(notionals[intent["symbol"]]) / equity * 100.0
        gross_pct = sum(abs(value) for value in notionals.values()) / equity * 100.0
        net_pct = abs(sum(notionals.values())) / equity * 100.0
        if symbol_pct > limits["maxSymbolExposurePct"]:
            return self._reject("symbol_exposure_limit")
        if gross_pct > limits["maxGrossExposurePct"]:
            return self._reject("gross_exposure_limit")
        if net_pct > limits["maxNetExposurePct"]:
            return self._reject("net_exposure_limit")
        if self.submission_mode == "shadow":
            signed_qty = float(qty) if intent["side"] == "buy" else -float(qty)
            self.reservations[intent["symbol"]] = float(self.reservations.get(intent["symbol"], 0)) + signed_qty
            return {"accepted": True, "reason_code": "accepted_shadow", "decided_at": _utc_now().isoformat(), "max_qty": max_qty}
        if self.submission_mode != "paper" or self.binding.get("brokerMode") != "paper" or self.binding.get("brokerKind") != "alpaca":
            return self._reject("submission_disabled")
        self._append_emit({"event_type": "submission_started", "intent_id": intent["intent_id"]})
        kwargs = {"reason": intent.get("reason"), "features": {"intent_id": intent["intent_id"]}, "client_order_id": intent["intent_id"]}
        try:
            order = self.broker.buy(intent["symbol"], qty=qty, reason=kwargs["reason"], features=kwargs["features"], client_order_id=kwargs["client_order_id"]) if intent["side"] == "buy" else self.broker.sell(intent["symbol"], qty=qty, reason=kwargs["reason"], features=kwargs["features"], client_order_id=kwargs["client_order_id"])
        except Exception as exc:
            # The request may have reached Alpaca even if its acknowledgement
            # did not reach us. Leave the intent pending in the durable ledger,
            # halt this process, and require lookup by client_order_id after a
            # restart before another decision can be made.
            self.halted = True
            self._append_emit({
                "event_type": "reconciliation", "status": "halted",
                "reason_code": "ambiguous_order_ack", "intent_id": intent["intent_id"],
                "detail": str(exc),
            })
            raise
        if str(order.status).lower().startswith("rejected"):
            self._append_emit({"event_type": "order_rejected", "intent_id": intent["intent_id"], "status": str(order.status)})
            return self._reject("broker_rejected")
        self._append_emit({"event_type": "order_ack", "intent_id": intent["intent_id"], "broker_order_id": str(order.order_id), "status": str(order.status)})
        signed_qty = float(qty) if intent["side"] == "buy" else -float(qty)
        self.reservations[intent["symbol"]] = float(self.reservations.get(intent["symbol"], 0)) + signed_qty
        return {"accepted": True, "reason_code": "accepted_paper", "decided_at": _utc_now().isoformat(), "max_qty": max_qty, "broker_order_id": str(order.order_id)}

    def safe_stop(self):
        try:
            snapshot = self._snapshot()
        except Exception as exc:
            self.halted = True
            self._append_emit({"event_type": "safe_stop", "status": "halted", "reason_code": "stale_account", "detail": str(exc)})
            return False
        flatten = bool((self.policy.get("limits") or {}).get("flattenOnStop"))
        open_positions = self._position_quantities(snapshot["positions"])
        capabilities = self.policy.get("capabilities") or {}
        if flatten and not capabilities.get("cancelAll"):
            self.halted = True
            self._append_emit({"event_type": "safe_stop", "status": "halted", "reason_code": "policy_incomplete", "positions": open_positions})
            return False
        if self.submission_mode == "paper":
            try:
                self.broker.cancel_all_orders()
                if flatten and open_positions:
                    self.broker.close_all_positions()
                snapshot = self._snapshot()
                open_positions = self._position_quantities(snapshot["positions"])
            except Exception as exc:
                self.halted = True
                self._append_emit({"event_type": "safe_stop", "status": "halted", "reason_code": "unresolved_divergence", "detail": str(exc), "positions": open_positions})
                return False
            if flatten and open_positions:
                self.halted = True
                self._append_emit({"event_type": "safe_stop", "status": "halted", "reason_code": "unresolved_divergence", "positions": open_positions})
                return False
        elif flatten and open_positions:
            self.halted = True
            self._append_emit({"event_type": "safe_stop", "status": "halted", "reason_code": "submission_disabled", "positions": open_positions})
            return False
        self._append_emit({"event_type": "broker_snapshot", **snapshot})
        self._append_emit({"event_type": "safe_stop", "status": "confirmed", "positions": snapshot["positions"]})
        return True


class IntentBroker:
    """Strategy-facing broker: reads delegate; buy/sell can only emit gateway intents."""
    __slots__ = ("__inner", "__gateway")

    def __init__(self, inner, gateway):
        object.__setattr__(self, "_IntentBroker__inner", inner)
        object.__setattr__(self, "_IntentBroker__gateway", gateway)

    def __getattribute__(self, name):
        if name in {"_inner", "_gateway", "_IntentBroker__inner", "_IntentBroker__gateway"}:
            raise AttributeError("raw broker access is not exposed to strategy code")
        return object.__getattribute__(self, name)

    SAFE_READS = frozenset({
        "cash", "equity", "position", "price", "greeks", "underlying_price",
        "days_to_expiry", "option_chain", "is_crypto", "is_option", "is_future",
    })

    def __getattr__(self, name):
        if name.startswith("_") or name not in self.SAFE_READS:
            raise AttributeError(f"broker operation {name!r} is not exposed to strategy code")
        return getattr(object.__getattribute__(self, "_IntentBroker__inner"), name)

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        gateway = object.__getattribute__(self, "_IntentBroker__gateway")
        return gateway.submit_intent("buy", symbol, qty, notional, reason, features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        if qty is None and notional is None:
            inner = object.__getattribute__(self, "_IntentBroker__inner")
            qty = abs(float(inner.position(symbol)))
        gateway = object.__getattribute__(self, "_IntentBroker__gateway")
        return gateway.submit_intent("sell", symbol, qty, notional, reason, features)
`
