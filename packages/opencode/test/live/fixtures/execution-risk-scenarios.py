from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timedelta, timezone

from execution_risk_gateway import DurableExecutionLedger, ExecutionRiskGateway, IntentBroker, _hash
from engine_v2.runtime.risk import RiskContract


class Broker:
    def __init__(self, *, equity=100.0, position=0.0, positions=None, fail_snapshot=False, allow_orders=False, fail_order=False):
        self.equity_value = equity
        self.position_value = position
        self.positions = positions if positions is not None else (
            {"AAPL": {"qty": position, "mark": 100.0}} if position != 0 else {}
        )
        self.fail_snapshot = fail_snapshot
        self.raw_orders = 0
        self.allow_orders = allow_orders
        self.fail_order = fail_order
        self.orders = {}
        self.cancelled = False
        self.closed = False

    def cash(self):
        if self.fail_snapshot:
            raise TimeoutError("account timeout")
        return self.equity_value

    def equity(self):
        if self.fail_snapshot:
            raise TimeoutError("account timeout")
        return self.equity_value

    def position(self, symbol):
        if self.fail_snapshot:
            raise TimeoutError("account timeout")
        return float((self.positions.get(symbol) or {}).get("qty", 0))

    def execution_snapshot(self, symbol):
        if self.fail_snapshot:
            raise TimeoutError("account timeout")
        return {
            "cash": self.equity_value,
            "equity": self.equity_value,
            "positions": self.positions,
        }

    def buy(self, *args, **kwargs):
        self.raw_orders += 1
        if not self.allow_orders:
            raise AssertionError("gateway called raw broker")
        if self.fail_order:
            raise TimeoutError("ambiguous acknowledgement")
        order = type("Order", (), {})()
        order.order_id = f"paper-{self.raw_orders}"
        order.id = order.order_id
        order.status = "accepted"
        client_id = kwargs.get("client_order_id")
        if client_id:
            self.orders[client_id] = order
        return order

    def sell(self, *args, **kwargs):
        return self.buy(*args, **kwargs)

    def get_order_by_client_id(self, client_id):
        return self.orders.get(client_id)

    def cancel_all_orders(self):
        self.cancelled = True

    def close_all_positions(self):
        self.closed = True
        self.positions = {}

    def _submit(self, *args, **kwargs):
        return self.buy(*args, **kwargs)

    def _place_market_order(self, *args, **kwargs):
        return self.buy(*args, **kwargs)


def contract(ledger_path, *, stop_mode="none", limits=True, flatten=False):
    policy = {
        "schema": "finny.execution_policy",
        "version": 1,
        "riskContract": {
            "sizing_stop_distance_pct": 10,
            "protective_stop": {"mode": stop_mode},
            "drawdown": {"mode": "halt_and_flatten_next_open", "limit_pct": 5},
            "max_positions": 1,
        },
        "capabilities": {
            "marketOrders": True,
            "fractionalQty": True,
            "cancelAll": False,
            "positionSnapshot": True,
        },
    }
    if limits:
        policy["limits"] = {
            "maxGrossExposurePct": 100,
            "maxNetExposurePct": 100,
            "maxSymbolExposurePct": 100,
            "maxAccountSnapshotAgeMs": 60_000,
            "maxMarketDataAgeMs": 3_600_000,
            "flattenOnStop": flatten,
        }
    result = {
        "schema": "finny.paper_execution_contract",
        "version": 1,
        "binding": {
            "runId": "qualified-run", "runIdentityHash": "a" * 64,
            "algorithmId": "algo", "algorithmVersion": 7, "strategyHash": "b" * 64,
            "riskPolicyHash": "c" * 64, "accountScopeHash": "d" * 64,
            "executionPolicyHash": _hash(policy), "effectiveConfigHash": "e" * 64,
            "symbol": "AAPL", "interval": "1min", "brokerKind": "alpaca", "brokerMode": "paper",
        },
        "policy": policy,
        "ledgerPath": ledger_path,
        "submissionEnabled": False,
    }
    return result


def paper_contract(ledger_path, *, flatten=False):
    result = contract(ledger_path, flatten=flatten)
    result["version"] = 2
    result.pop("submissionEnabled")
    result["submissionMode"] = "paper"
    result["policy"]["capabilities"]["cancelAll"] = True
    result["binding"]["executionPolicyHash"] = _hash(result["policy"])
    return result


def bar(offset_minutes=0, *, final=True, open_price=100.0):
    end = datetime.now(timezone.utc) - timedelta(seconds=5) + timedelta(minutes=offset_minutes)
    start = end - timedelta(minutes=1)
    return {
        "timestamp": start.isoformat(), "bar_start": start.isoformat(), "bar_end": end.isoformat(),
        "is_final": final, "session_id": start.date().isoformat(),
        "source_timestamp": datetime.now(timezone.utc).isoformat(),
        "open": open_price, "high": open_price + 1, "low": open_price - 1,
        "close": open_price, "volume": 1000,
    }


def last_decision(events):
    return [event for event in events if event.get("event_type") == "decision"][-1]


def scenario_bar_and_risk(tmp, emitted):
    ledger = os.path.join(tmp, "events.jsonl")
    broker = Broker()
    gateway = ExecutionRiskGateway(contract(ledger), broker, emitted.append)
    assert gateway.reconcile_start()

    open_bar = bar(final=False)
    assert not gateway.begin_bar(open_bar)
    late_final = dict(open_bar)
    late_final["is_final"] = True
    assert gateway.begin_bar(late_final)
    assert not gateway.begin_bar(dict(gateway.current_bar))

    facade = IntentBroker(broker, gateway)
    assert_raw_broker_hidden(facade)
    engine_risk = RiskContract.from_config({"risk_contract": contract(ledger)["policy"]["riskContract"]})
    assert engine_risk.max_position_qty(equity=100, price=100) == 0.5
    assert facade.buy("AAPL", qty=1, reason="forced one share").decision["reason_code"] == "risk_size_exceeded"
    assert facade.buy("AAPL", qty=0.3, reason="bounded leg one").decision["reason_code"] == "accepted_shadow"
    assert facade.buy("AAPL", qty=0.3, reason="bounded leg two").decision["reason_code"] == "risk_size_exceeded"
    assert facade.buy("AAPL", qty=0.3, reason="bounded leg one").decision["reason_code"] == "duplicate_intent"
    assert broker.raw_orders == 0

    tampered = gateway._make_intent("buy", "AAPL", 0.1, None, "tampered policy", None)
    tampered["execution_policy_hash"] = "f" * 64
    assert gateway._decide(tampered)["reason_code"] == "binding_mismatch"
    gateway.policy["limits"]["maxGrossExposurePct"] = 999
    policy_tampered = gateway._make_intent("buy", "AAPL", 0.1, None, "tampered policy body", None)
    assert gateway._decide(policy_tampered)["reason_code"] == "binding_mismatch"
    gateway.policy["limits"]["maxGrossExposurePct"] = 100

    assert gateway.begin_bar(bar(offset_minutes=1, open_price=200))
    assert facade.buy("AAPL", qty=0.5, reason="overnight gap").decision["reason_code"] == "risk_size_exceeded"
    return ledger


def assert_raw_broker_hidden(facade):
    for name in ("_inner", "_submit", "_place_market_order", "submit_order", "execution_snapshot"):
        try:
            getattr(facade, name)
            raise AssertionError(f"raw broker operation escaped facade: {name}")
        except AttributeError:
            pass
    assert facade.cash() == 100


def scenario_policy_gates(tmp, emitted):
    missing = ExecutionRiskGateway(contract(os.path.join(tmp, "missing.jsonl"), limits=False), Broker(), emitted.append)
    assert missing.reconcile_start() and missing.begin_bar(bar(offset_minutes=2))
    assert IntentBroker(missing.broker, missing).buy("AAPL", qty=0.1).decision["reason_code"] == "policy_incomplete"

    stop_contract = contract(os.path.join(tmp, "stop.jsonl"), stop_mode="strategy_next_open")
    stop_contract["policy"]["riskContract"]["drawdown"]["limit_pct"] = 100
    stop_contract["policy"]["limits"]["maxSymbolExposurePct"] = 10
    stop_contract["binding"]["executionPolicyHash"] = _hash(stop_contract["policy"])
    stop = ExecutionRiskGateway(stop_contract, Broker(), emitted.append)
    assert stop.reconcile_start() and stop.begin_bar(bar(offset_minutes=3))
    stop_broker = IntentBroker(stop.broker, stop)
    assert stop_broker.buy("AAPL", qty=0.1).decision["reason_code"] == "protective_stop_required"
    stop.account["positions"]["AAPL"] = {"qty": 1, "mark": 100}
    assert stop_broker.buy("AAPL", qty=0.1, features={"stop_reference": 90}).decision["reason_code"] == "symbol_exposure_limit"

    flip_contract = contract(os.path.join(tmp, "side-flip.jsonl"), stop_mode="strategy_next_open")
    flip = ExecutionRiskGateway(flip_contract, Broker(position=0.4), emitted.append)
    assert flip.reconcile_start() and flip.begin_bar(bar(offset_minutes=4))
    flip_broker = IntentBroker(flip.broker, flip)
    assert flip_broker.sell("AAPL", qty=0.8).decision["reason_code"] == "protective_stop_required"
    assert flip_broker.sell("AAPL", qty=1, features={"stop_reference": 110}).decision["reason_code"] == "risk_size_exceeded"

    quote_contract = contract(os.path.join(tmp, "quote-currency.jsonl"))
    quote_contract["binding"].update({"brokerKind": "binance", "symbol": "ETH/BTC"})
    quote = ExecutionRiskGateway(quote_contract, Broker(), emitted.append)
    assert quote.reconcile_start() and quote.begin_bar(bar(offset_minutes=4))
    assert IntentBroker(quote.broker, quote).buy("ETH/BTC", qty=0.1).decision["reason_code"] == "account_currency_mismatch"

    drawdown_broker = Broker(equity=100)
    drawdown = ExecutionRiskGateway(contract(os.path.join(tmp, "drawdown.jsonl")), drawdown_broker, emitted.append)
    assert drawdown.reconcile_start()
    drawdown_broker.equity_value = 94
    assert not drawdown.begin_bar(bar(offset_minutes=4)) and drawdown.halted


def exposure_gateway(tmp, name, positions, limits):
    broker = Broker(equity=100, positions=positions)
    policy = contract(os.path.join(tmp, f"{name}.jsonl"))
    policy["policy"]["riskContract"]["drawdown"]["limit_pct"] = 100
    policy["policy"]["riskContract"]["max_positions"] = 3
    policy["policy"]["limits"].update(limits)
    policy["binding"]["executionPolicyHash"] = _hash(policy["policy"])
    gateway = ExecutionRiskGateway(policy, broker, lambda _event: None)
    assert gateway.reconcile_start() and gateway.begin_bar(bar(offset_minutes=5))
    return IntentBroker(broker, gateway)


def scenario_account_wide_exposure(tmp):
    gross = exposure_gateway(
        tmp, "gross", {"MSFT": {"qty": 0.8, "mark": 100}},
        {"maxGrossExposurePct": 150, "maxNetExposurePct": 300, "maxSymbolExposurePct": 100},
    )
    assert gross.buy("AAPL", qty=0.8).decision["reason_code"] == "gross_exposure_limit"

    net = exposure_gateway(
        tmp, "net", {"MSFT": {"qty": -0.5, "mark": 100}},
        {"maxGrossExposurePct": 300, "maxNetExposurePct": 100, "maxSymbolExposurePct": 300},
    )
    assert net.buy("AAPL", qty=2).decision["reason_code"] == "net_exposure_limit"

    symbol = exposure_gateway(
        tmp, "symbol", {},
        {"maxGrossExposurePct": 300, "maxNetExposurePct": 300, "maxSymbolExposurePct": 100},
    )
    assert symbol.buy("AAPL", qty=2).decision["reason_code"] == "symbol_exposure_limit"


def scenario_reconciliation_faults(tmp, emitted):
    timeout = ExecutionRiskGateway(contract(os.path.join(tmp, "timeout.jsonl")), Broker(fail_snapshot=True), emitted.append)
    assert not timeout.reconcile_start() and timeout.halted
    flatten = ExecutionRiskGateway(contract(os.path.join(tmp, "flatten.jsonl"), flatten=True), Broker(position=2), emitted.append)
    assert flatten.reconcile_start() and not flatten.safe_stop() and flatten.halted

    crash_path = os.path.join(tmp, "crash.jsonl")
    DurableExecutionLedger(crash_path).append({"event_type": "intent", "intent_id": "orphan"})
    recovered = ExecutionRiskGateway(contract(crash_path), Broker(), emitted.append)
    assert "orphan" in recovered.known_outcomes
    assert any(event.get("recovered") for event in recovered.ledger.events)

    torn_path = os.path.join(tmp, "torn.jsonl")
    DurableExecutionLedger(torn_path).append({"event_type": "intent", "intent_id": "torn-orphan"})
    with open(torn_path, "ab") as handle:
        handle.write(b'{"event_type":"decision"')
    with open(torn_path, "rb") as handle:
        torn_before = handle.read()
    torn = ExecutionRiskGateway(contract(torn_path), Broker(), emitted.append)
    assert torn.halted and not torn.reconcile_start()
    assert "torn-orphan" not in torn.known_outcomes
    with open(torn_path, "rb") as handle:
        assert handle.read() == torn_before


def scenario_paper_submission(tmp, emitted):
    ledger = os.path.join(tmp, "paper.jsonl")
    broker = Broker(allow_orders=True)
    gateway = ExecutionRiskGateway(paper_contract(ledger), broker, emitted.append)
    assert gateway.reconcile_start() and gateway.begin_bar(bar(offset_minutes=6))
    result = IntentBroker(broker, gateway).buy("AAPL", qty=0.1, reason="signed activation")
    assert result.decision["reason_code"] == "accepted_paper"
    assert broker.raw_orders == 1
    events = gateway.ledger.events
    assert {"submission_started", "order_ack"} <= {event["event_type"] for event in events}

    ambiguous_path = os.path.join(tmp, "paper-ambiguous.jsonl")
    ambiguous_broker = Broker(allow_orders=True, fail_order=True)
    ambiguous = ExecutionRiskGateway(paper_contract(ambiguous_path), ambiguous_broker, emitted.append)
    assert ambiguous.reconcile_start() and ambiguous.begin_bar(bar(offset_minutes=7))
    try:
        IntentBroker(ambiguous_broker, ambiguous).buy("AAPL", qty=0.1)
        raise AssertionError("expected ambiguous broker failure")
    except TimeoutError:
        pass
    assert ambiguous.halted
    assert any(
        event.get("reason_code") == "ambiguous_order_ack" and event.get("status") == "halted"
        for event in ambiguous.ledger.events
    )
    assert not any(event.get("event_type") == "decision" for event in ambiguous.ledger.events)

    pending_path = os.path.join(tmp, "paper-pending.jsonl")
    pending = DurableExecutionLedger(pending_path)
    pending.append({"event_type": "intent", "intent_id": "ambiguous-order"})
    recovered_broker = Broker(allow_orders=True)
    existing = type("Order", (), {})()
    existing.id = "broker-existing"
    existing.status = "accepted"
    recovered_broker.orders["ambiguous-order"] = existing
    recovered = ExecutionRiskGateway(paper_contract(pending_path), recovered_broker, emitted.append)
    assert recovered.reconcile_start()
    assert "ambiguous-order" in recovered.known_outcomes

    stop_broker = Broker(position=0.1, allow_orders=True)
    stopping = ExecutionRiskGateway(paper_contract(os.path.join(tmp, "paper-stop.jsonl"), flatten=True), stop_broker, emitted.append)
    assert stopping.reconcile_start() and stopping.safe_stop()
    assert stop_broker.cancelled and stop_broker.closed


def assert_durable_event_set(ledger):
    with open(ledger, encoding="utf-8") as handle:
        durable = [json.loads(line) for line in handle if line.strip()]
    assert {"intent", "decision", "bar_advanced", "reconciliation", "broker_snapshot"} <= {
        event["event_type"] for event in durable
    }
    return durable


def main():
    with tempfile.TemporaryDirectory(prefix="finny-risk-fixture-") as tmp:
        emitted = []
        ledger = scenario_bar_and_risk(tmp, emitted)
        scenario_policy_gates(tmp, emitted)
        scenario_account_wide_exposure(tmp)
        scenario_reconciliation_faults(tmp, emitted)
        scenario_paper_submission(tmp, emitted)
        durable = assert_durable_event_set(ledger)
        print(json.dumps({"ok": True, "events": len(durable), "last_reason": last_decision(durable)["reason_code"]}))


if __name__ == "__main__":
    main()
