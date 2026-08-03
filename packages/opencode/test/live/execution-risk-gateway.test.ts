import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  EXECUTION_RISK_GATEWAY_PY,
  accountScopeHash,
  createLiveActivationReceipt,
  executionLedgerPath,
  verifyLiveActivationReceipt,
  verifyPaperActivationReceipt,
} from "../../src/live/execution-risk-gateway"
import crypto from "node:crypto"
import { FINNY_BROKER_PY } from "../../src/backtest/broker-py"
import { LiveRunner } from "../../src/live/runner"
import { sha256Text, stableStringify } from "../../src/backtest/run-integrity-core"

let temp = ""

beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "finny-execution-gateway-test-"))
  await fs.writeFile(path.join(temp, "execution_risk_gateway.py"), EXECUTION_RISK_GATEWAY_PY)
  await fs.writeFile(path.join(temp, "finny_broker.py"), FINNY_BROKER_PY)
  await fs.writeFile(path.join(temp, "live_worker.py"), LiveRunner.LIVE_WORKER_PY)
})

afterAll(async () => {
  await fs.rm(temp, { recursive: true, force: true })
})

describe("paper execution risk gateway", () => {
  test("binds a short-lived live receipt to the complete immutable Robinhood identity", () => {
    const binding = {
      runId: "strict-run",
      runIdentityHash: "a".repeat(64),
      algorithmId: "algo",
      algorithmVersion: 3,
      strategyHash: "b".repeat(64),
      riskPolicyHash: "c".repeat(64),
      executionPolicyHash: "d".repeat(64),
      effectiveConfigHash: "e".repeat(64),
      symbol: "AAPL",
      interval: "1min",
      brokerKind: "robinhood" as const,
      brokerMode: "live" as const,
      accountScopeHash: "f".repeat(64),
    }
    const now = new Date("2026-08-03T12:00:00Z")
    const receipt = createLiveActivationReceipt({
      challengeId: "challenge-1",
      binding,
      secret: "daemon-process-secret",
      now,
    })
    expect(verifyLiveActivationReceipt({ receipt, binding, secret: "daemon-process-secret", now })).toEqual([])
    expect(
      verifyLiveActivationReceipt({
        receipt,
        binding: { ...binding, symbol: "MSFT" },
        secret: "daemon-process-secret",
        now,
      }),
    ).toContain("live activation binding mismatch")
    expect(
      verifyLiveActivationReceipt({
        receipt,
        binding,
        secret: "daemon-process-secret",
        now: new Date(receipt.expiresAt),
      }),
    ).toContain("live activation receipt is expired or invalid")
  })

  test("requires an HMAC-signed activation receipt bound to the exact strict run", () => {
    const binding = {
      runId: "strict-run",
      runIdentityHash: "a".repeat(64),
      algorithmId: "algo",
      algorithmVersion: 1,
      strategyHash: "b".repeat(64),
      riskPolicyHash: "c".repeat(64),
      executionPolicyHash: "d".repeat(64),
      effectiveConfigHash: "e".repeat(64),
      symbol: "AAPL",
      interval: "1min",
      brokerKind: "alpaca" as const,
      brokerMode: "paper" as const,
      accountScopeHash: "f".repeat(64),
    }
    const secret = "activation-secret"
    const body = {
      schema: "finny.paper_activation_receipt" as const,
      version: 1 as const,
      runId: "fund-run",
      strictRunId: binding.runId,
      strategyHash: binding.strategyHash,
      riskPolicyHash: binding.riskPolicyHash,
      accountScopeHash: binding.accountScopeHash,
      approvedByDiscordUserId: "discord-admin",
      shadowProofHash: "1".repeat(64),
      activatedAt: "2026-07-19T12:00:00.000Z",
    }
    const receiptHash = sha256Text(stableStringify(body))
    const receipt = {
      ...body,
      receiptHash,
      signature: crypto.createHmac("sha256", secret).update(receiptHash).digest("hex"),
    }
    expect(verifyPaperActivationReceipt({ receipt, binding, secret })).toEqual([])
    expect(
      verifyPaperActivationReceipt({ receipt: { ...receipt, strategyHash: "0".repeat(64) }, binding, secret }),
    ).toContain("paper activation receipt hash mismatch")
    expect(verifyPaperActivationReceipt({ receipt, binding, secret: "wrong" })).toContain(
      "paper activation receipt signature mismatch",
    )
  })

  test("maps privacy-safe gateway decisions into native execution telemetry", () => {
    const [event] = LiveRunner.nativeEventsForMessageForTests(
      {
        id: "paper-run",
        algorithmId: "algo",
        algorithmName: "Algo",
        symbol: "AAPL",
        interval: "1min",
        brokerKind: "alpaca",
        mode: "paper",
      },
      {
        type: "execution_event",
        event_type: "decision",
        intent_id: "intent-hash",
        watermark: "2026-07-14T15:31:00.000Z",
        risk_policy_hash: "policy-hash",
        reason_code: "risk_size_exceeded",
      },
    )
    expect(event).toMatchObject({
      eventType: "risk.decision",
      status: "risk_size_exceeded",
      runId: "paper-run",
    })
    expect(event?.payload).not.toHaveProperty("accountProviderID")
  })

  test("uses redacted stable deployment identity and durable path", () => {
    const hash = accountScopeHash({ brokerKind: "alpaca", accountProviderID: "secret-account-id" })
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain("secret-account-id")
    const file = executionLedgerPath({
      algorithmId: "algo",
      algorithmVersion: 7,
      accountScopeHash: hash,
      symbol: "AAPL",
      env: { FINNY_HOME: temp },
    })
    expect(file).toStartWith(temp)
    expect(file).toEndWith(".jsonl")
    expect(file).not.toContain("secret-account-id")
  })

  test("hashes the complete execution policy identically in TypeScript and Python", async () => {
    const policy = {
      schema: "finny.execution_policy",
      version: 1,
      riskContract: {
        sizing_stop_distance_pct: 2.5,
        protective_stop: { mode: "strategy_next_open" },
        drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 5 },
        max_positions: 2,
      },
      limits: {
        maxGrossExposurePct: 125,
        maxNetExposurePct: 75,
        maxSymbolExposurePct: 50,
        maxAccountSnapshotAgeMs: 10_000,
        maxMarketDataAgeMs: 60_000,
        flattenOnStop: true,
      },
      capabilities: { marketOrders: true, fractionalQty: false, cancelAll: true, positionSnapshot: true },
    }
    const script = "import json,sys; from execution_risk_gateway import _hash; print(_hash(json.loads(sys.argv[1])))"
    const proc = Bun.spawn(["python3", "-c", script, JSON.stringify(policy)], {
      cwd: temp,
      env: { ...process.env, PYTHONPATH: temp },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(sha256Text(stableStringify(policy)))
  })

  test("Robinhood live gateway refuses an intent that would create a short position", async () => {
    const policy = {
      schema: "finny.execution_policy",
      version: 1,
      riskContract: {
        sizing_stop_distance_pct: 2,
        protective_stop: { mode: "strategy_next_open" },
        drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 5 },
        max_positions: 2,
      },
      limits: {
        maxGrossExposurePct: 100,
        maxNetExposurePct: 100,
        maxSymbolExposurePct: 50,
        maxAccountSnapshotAgeMs: 60_000,
        maxMarketDataAgeMs: 60_000,
        flattenOnStop: false,
      },
      capabilities: { marketOrders: true, fractionalQty: true, cancelAll: true, positionSnapshot: true },
    }
    const binding = {
      runId: "run",
      runIdentityHash: "a".repeat(64),
      algorithmId: "algo",
      algorithmVersion: 1,
      strategyHash: "b".repeat(64),
      riskPolicyHash: "c".repeat(64),
      executionPolicyHash: sha256Text(stableStringify(policy)),
      effectiveConfigHash: "d".repeat(64),
      symbol: "AAPL",
      interval: "1min",
      brokerKind: "robinhood",
      brokerMode: "live",
      accountScopeHash: "e".repeat(64),
    }
    const receipt = {
      schema: "finny.live_activation_receipt",
      version: 1,
      challengeId: "challenge",
      ...binding,
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      receiptHash: "f".repeat(64),
      signature: "0".repeat(64),
    }
    const contract = {
      schema: "finny.execution_contract",
      version: 3,
      binding,
      policy,
      ledgerPath: path.join(temp, `long-only-${crypto.randomUUID()}.jsonl`),
      submissionMode: "live",
      activationReceipt: receipt,
    }
    const script = String.raw`
import json,sys
from datetime import datetime, timezone, timedelta
from execution_risk_gateway import ExecutionRiskGateway
class Broker:
    def execution_snapshot(self, symbol):
        return {"cash": 10000, "equity": 10000, "positions": {}}
contract=json.loads(sys.argv[1])
gateway=ExecutionRiskGateway(contract, Broker(), lambda event: None)
assert gateway.reconcile_start()
now=datetime.now(timezone.utc)
bar={"bar_start":(now-timedelta(minutes=1)).isoformat(),"bar_end":now.isoformat(),"is_final":True,"session_id":"regular","source_timestamp":now.isoformat(),"open":100}
assert gateway.begin_bar(bar)
result=gateway.submit_intent("sell", "AAPL", qty=1, reason="must not short", features={})
print(json.dumps(result.decision))
`
    const proc = Bun.spawn(["python3", "-c", script, JSON.stringify(contract)], {
      cwd: temp,
      env: { ...process.env, PYTHONPATH: temp },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ accepted: false, reason_code: "long_only" })
  })

  test("passes closed-bar, risk parity, idempotency, crash, timeout, and safe-stop corpus", async () => {
    const fixture = path.join(import.meta.dir, "fixtures", "execution-risk-scenarios.py")
    const packageRoot = path.join(import.meta.dir, "../..")
    const proc = Bun.spawn(["python3", fixture], {
      cwd: packageRoot,
      env: { ...process.env, PYTHONPATH: `${temp}${path.delimiter}${packageRoot}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ ok: true })
  })

  test("generated provider and worker modules compile and expose conservative bar finality", async () => {
    const check = String.raw`
from datetime import datetime, timedelta, timezone
from finny_broker import finalized_bar_contract, newest_finalized_bar
now = datetime.now(timezone.utc)
assert finalized_bar_contract(now, "1min")["is_final"] is False
final = finalized_bar_contract(now - timedelta(minutes=2), "1min")
assert final["is_final"] is True
assert {"bar_start", "bar_end", "is_final", "session_id", "source_timestamp"} <= set(final)
prior = {"timestamp": now - timedelta(minutes=2), "name": "prior-final"}
latest = {"timestamp": now, "name": "latest-open"}
selected, selected_finality = newest_finalized_bar([prior, latest], "1min", lambda item: item["timestamp"])
assert selected["name"] == "prior-final"
assert selected_finality["is_final"] is True
`
    const proc = Bun.spawn(["python3", "-c", check], {
      cwd: temp,
      env: { ...process.env, PYTHONPATH: temp },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const compile = Bun.spawn(
      ["python3", "-m", "py_compile", "finny_broker.py", "execution_risk_gateway.py", "live_worker.py"],
      {
        cwd: temp,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [compileCode, compileError] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
    expect(compileError).toBe("")
    expect(compileCode).toBe(0)
    expect(FINNY_BROKER_PY).toContain("fetch_ohlcv(norm, timeframe=tf, limit=2)")
  })
})
