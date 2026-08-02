import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FINNY_BROKER_PY } from "../../src/backtest/broker-py"
import { FINNY_LIVE_BROKER_PY } from "../../src/backtest/live-broker-py"
import { tmpdir } from "../fixture/fixture"

const fakeRhx = String.raw`#!/usr/bin/env python3
import json
import sys

symbol = sys.argv[-1]
meta = {"output_schema": "v4"}

if symbol in ("ERROR", "BADCODE"):
    print(json.dumps({
        "ok": False,
        "data": None,
        "error": {
            "code": "AUTH_REQUIRED" if symbol == "ERROR" else "SECRET: injected detail",
            "message": "secret-account@example.com",
        },
        "meta": meta,
    }))
    raise SystemExit(3)

print(json.dumps({
    "ok": True,
    "data": {"symbol": symbol, "quote": {"bid_price": "9", "ask_price": "11"}},
    "error": None,
    "meta": meta,
}))
print(json.dumps({
    "ok": False,
    "data": None,
    "error": {"code": "STDERR_ERROR", "message": "must not replace stdout"},
    "meta": meta,
}), file=sys.stderr)
`

const scenario = String.raw`import os
import sys

sys.path.insert(0, os.getcwd())
from finny_broker import RobinhoodBroker

broker = RobinhoodBroker(profile="work", command=os.environ["FAKE_RHX_PATH"], symbol="AAPL")

# The subprocess boundary accepts symbols, never option-like arguments, and
# prefers stdout's v4 envelope even when stderr contains another envelope.
assert broker._quote("AAPL") == {"bid": 9.0, "ask": 11.0, "last": 10.0}
for unsafe in ("", "-X", "--profile", "AAPL;live-on"):
    try:
        broker._run(["quote", "get", unsafe])
        raise AssertionError(f"unsafe quote symbol was accepted: {unsafe!r}")
    except RuntimeError as exc:
        assert "shadow-only strategy worker" in str(exc)

try:
    broker._run(["quote", "get", "ERROR"])
    raise AssertionError("error envelope was accepted")
except RuntimeError as exc:
    assert str(exc) == "AUTH_REQUIRED: rhx command failed"
    assert "secret-account" not in str(exc)

try:
    broker._run(["quote", "get", "BADCODE"])
    raise AssertionError("invalid error code was accepted")
except RuntimeError as exc:
    assert str(exc) == "RHX_ERROR: rhx command failed"

# Instrument requests use a rebuilt canonical URL, not the untrusted original.
assert broker._validated_instrument_url(
    "https://api.robinhood.com/instruments/aapl"
) == "https://api.robinhood.com/instruments/aapl/"

class InvalidInstrumentBroker(RobinhoodBroker):
    def _run(self, args, provider=None):
        return {
            "symbol": "AAPL",
            "quote": {
                "instrument": "https://example.com/instruments/aapl/",
                "bid_price": "9",
                "ask_price": "11",
            },
        }

try:
    InvalidInstrumentBroker(symbol="AAPL")._quote("AAPL")
    raise AssertionError("untrusted quote instrument URL was cached")
except RuntimeError as exc:
    assert "invalid Robinhood instrument URL" in str(exc)

class DeterministicQuoteBroker(RobinhoodBroker):
    def _run(self, args, provider=None):
        return {
            "symbol": "BTC-USD",
            "quote": {
                "results": [
                    {
                        "symbol": "ETH-USD",
                        "bid_inclusive_of_sell_spread": "999",
                        "ask_inclusive_of_buy_spread": "1001",
                    },
                    {
                        "symbol": "BTC-USD",
                        "bid_inclusive_of_sell_spread": "199",
                        "ask_inclusive_of_buy_spread": "201",
                    },
                ],
            },
        }

deterministic = DeterministicQuoteBroker(symbol="BTC-USD")
assert deterministic._quote("BTC-USD", provider="crypto") == {
    "bid": 199.0,
    "ask": 201.0,
    "last": 200.0,
}

class DeepQuoteBroker(RobinhoodBroker):
    def _run(self, args, provider=None):
        root = {}
        cursor = root
        for _ in range(20):
            cursor["child"] = {}
            cursor = cursor["child"]
        return {"symbol": "AAPL", "quote": root}

try:
    DeepQuoteBroker(symbol="AAPL")._quote("AAPL")
    raise AssertionError("excessively nested quote payload was accepted")
except RuntimeError as exc:
    assert type(exc) is RuntimeError
    assert "nesting depth" in str(exc)

class CountingCryptoBroker(RobinhoodBroker):
    def __init__(self):
        super().__init__(symbol="BTC-USD")
        self.calls = []

    def _run(self, args, provider=None):
        self.calls.append((provider, *args))
        if args == ["account", "summary"]:
            return {"buying_power": "100"}
        if args == ["positions", "list"]:
            return [
                {"asset_code": "BTC", "total_quantity": "0.5"},
                {"asset_code": "ETH", "total_quantity": "2"},
            ]
        if args == ["quote", "get", "BTC-USD"]:
            return {
                "symbol": "BTC-USD",
                "quote": {"results": [{
                    "symbol": "BTC-USD",
                    "bid_inclusive_of_sell_spread": "199",
                    "ask_inclusive_of_buy_spread": "201",
                }]},
            }
        if args == ["quote", "get", "ETH-USD"]:
            return {
                "symbol": "ETH-USD",
                "quote": {"results": [{
                    "symbol": "ETH-USD",
                    "bid_inclusive_of_sell_spread": "9",
                    "ask_inclusive_of_buy_spread": "11",
                }]},
            }
        raise AssertionError(f"unexpected RHX call: {provider=} {args=}")

crypto = CountingCryptoBroker()
assert crypto.execution_snapshot("BTC-USD") == {
    "cash": 100.0,
    "equity": 220.0,
    "positions": {
        "BTC-USD": {"qty": 0.5, "mark": 200.0},
        "ETH-USD": {"qty": 2.0, "mark": 10.0},
    },
}
assert crypto.calls.count(("crypto", "account", "summary")) == 1
assert crypto.calls.count(("crypto", "positions", "list")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "BTC-USD")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "ETH-USD")) == 1

crypto.calls.clear()
assert crypto.cash() == 100.0
assert crypto.calls.count(("crypto", "account", "summary")) == 1
assert crypto.calls.count(("crypto", "positions", "list")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "BTC-USD")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "ETH-USD")) == 1

crypto.calls.clear()
assert crypto.equity() == 220.0
assert crypto.calls.count(("crypto", "account", "summary")) == 1
assert crypto.calls.count(("crypto", "positions", "list")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "BTC-USD")) == 1
assert crypto.calls.count(("crypto", "quote", "get", "ETH-USD")) == 1

# A guaranteed shadow rejection must not perform a position or quote lookup.
before_sell = list(crypto.calls)
rejected = crypto.sell("BTC-USD", reason="review-test", features={"source": "test"})
assert rejected.status.startswith("rejected: Robinhood order submission is disabled")
assert rejected.reason == "review-test"
assert rejected.features == {"source": "test"}
assert crypto.calls == before_sell
`

async function runPython(cwd: string, script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["python3", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("shared broker prelude keeps the time dependency without Robinhood subprocess imports", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "base_broker.py"), FINNY_BROKER_PY)

  expect(
    await runPython(
      tmp.path,
      "import base_broker; assert base_broker.time.time() > 0; assert not hasattr(base_broker, 'subprocess')",
    ),
  ).toEqual({ exitCode: 0, stdout: "", stderr: "" })
})

test("Robinhood adapter applies the reviewed RHX parsing and snapshot boundaries", async () => {
  await using tmp = await tmpdir()
  const brokerPath = path.join(tmp.path, "finny_broker.py")
  const fakeRhxPath = path.join(tmp.path, "fake_rhx.py")
  await Bun.write(brokerPath, FINNY_LIVE_BROKER_PY)
  await Bun.write(fakeRhxPath, fakeRhx)
  await fs.chmod(fakeRhxPath, 0o700)

  expect(await runPython(tmp.path, scenario, { FAKE_RHX_PATH: fakeRhxPath })).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  })
})
