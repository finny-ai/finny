import { describe, expect, test } from "bun:test"
import {
  buildQcCompositeRunIdentity,
  buildQcExecutionTarget,
  buildQcSourceSnapshot,
  canonicalizeQcStatistics,
  compareSourceTrees,
  isSafeQcPath,
  qcDriftState,
  qcLanguageFromProject,
  sha256Text,
  sourceTreeHashForFiles,
} from "../../src/integration/qc-contracts"

const file = (path: string, content: string) => ({
  path,
  sha256: sha256Text(content),
  bytes: Buffer.byteLength(content, "utf8"),
})

describe("QC source snapshots", () => {
  test("hashes are canonical regardless of file order", () => {
    const a = sourceTreeHashForFiles([file("main.py", "x"), file("utils.py", "y")])
    const b = sourceTreeHashForFiles([file("utils.py", "y"), file("main.py", "x")])
    expect(a).toBe(b)
  })

  test("rejects unsafe paths", () => {
    expect(isSafeQcPath("main.py")).toBe(true)
    expect(isSafeQcPath("sub/dir/main.py")).toBe(true)
    expect(isSafeQcPath("/abs/main.py")).toBe(false)
    expect(isSafeQcPath("../main.py")).toBe(false)
    expect(isSafeQcPath("a\\b.py")).toBe(false)
  })

  test("snapshot sorts files and carries a stable tree hash", () => {
    const snapshot = buildQcSourceSnapshot({
      algorithmId: "algo-1",
      algorithmVersion: 3,
      files: [file("b.py", "b"), file("a.py", "a")],
    })
    expect(snapshot.files.map((f) => f.path)).toEqual(["a.py", "b.py"])
    expect(snapshot.sourceTreeHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("source tree comparison and drift", () => {
  const local = [file("main.py", "v1")]
  const remoteSame = [file("main.py", "v1")]
  const remoteChanged = [file("main.py", "v2")]

  test("identical trees are in sync", () => {
    expect(compareSourceTrees(local, remoteSame).same).toBe(true)
    const drift = qcDriftState({
      local,
      remote: remoteSame,
      lastSyncedLocalHash: sourceTreeHashForFiles(local),
      lastSyncedRemoteHash: sourceTreeHashForFiles(remoteSame),
    })
    expect(drift.state).toBe("in_sync")
  })

  test("remote change is qc_changed", () => {
    const drift = qcDriftState({
      local,
      remote: remoteChanged,
      lastSyncedLocalHash: sourceTreeHashForFiles(local),
      lastSyncedRemoteHash: sourceTreeHashForFiles(remoteSame),
    })
    expect(drift.state).toBe("qc_changed")
  })

  test("both changed is blocked", () => {
    const drift = qcDriftState({
      local: [file("main.py", "local-v2")],
      remote: remoteChanged,
      lastSyncedLocalHash: sourceTreeHashForFiles(local),
      lastSyncedRemoteHash: sourceTreeHashForFiles(remoteSame),
    })
    expect(drift.state).toBe("both_changed")
  })

  test("adds/removes/changes are reported", () => {
    const comparison = compareSourceTrees(
      [file("main.py", "v1"), file("old.py", "x")],
      [file("main.py", "v2"), file("new.py", "y")],
    )
    expect(comparison.changed).toEqual(["main.py"])
    expect(comparison.added).toEqual(["new.py"])
    expect(comparison.removed).toEqual(["old.py"])
  })
})

describe("QC language and statistics canonicalization", () => {
  test("maps project language strings", () => {
    expect(qcLanguageFromProject("Py")).toBe("python")
    expect(qcLanguageFromProject("C#")).toBe("csharp")
    expect(qcLanguageFromProject("csharp")).toBe("csharp")
  })

  test("canonicalizes percent and currency strings into Finny units", () => {
    const canonical = canonicalizeQcStatistics({
      "Total Return": "12.34%",
      "Sharpe Ratio": "1.98",
      Drawdown: "-8.10%",
      "Total Trades": "42",
      Fees: "-$3.40",
      Equity: "$100,000.00",
      Alpha: "0.05%",
    })
    expect(canonical.total_return).toBeCloseTo(0.1234, 6)
    expect(canonical.sharpe).toBeCloseTo(1.98, 6)
    expect(canonical.max_drawdown).toBeCloseTo(-0.081, 6)
    expect(canonical.total_trades).toBe(42)
    expect(canonical.fees).toBeCloseTo(-3.4, 6)
    expect(canonical.equity).toBeCloseTo(100000, 6)
    expect(canonical.alpha).toBeCloseTo(0.0005, 6)
  })

  test("missing statistics are undefined, not NaN", () => {
    const canonical = canonicalizeQcStatistics({})
    expect(canonical.total_return).toBeUndefined()
    expect(canonical.total_trades).toBeUndefined()
  })
})

describe("composite and execution identities", () => {
  test("composite identity binds local and cloud evidence into a stable hash", () => {
    const identity = buildQcCompositeRunIdentity({
      algorithmId: "algo-1",
      algorithmVersion: 2,
      runId: "run-1",
      local: {
        runId: "run-1",
        identityHash: "a".repeat(64),
        runtimeHash: "b".repeat(64),
        engine: "lean_python",
      },
      cloud: {
        projectId: 42,
        compileId: "c1",
        backtestId: "bt1",
        leanVersionId: 17202,
        sourceTreeHash: "c".repeat(64),
        parameters: { symbol: "SPY", capital: 10000 },
        statistics: { "Total Return": "1.00%" },
        backtestUrl: "https://www.quantconnect.com/project/42/backtest/bt1",
      },
    })
    expect(identity.compositeHash).toMatch(/^[a-f0-9]{64}$/)
    const again = buildQcCompositeRunIdentity({
      algorithmId: "algo-1",
      algorithmVersion: 2,
      runId: "run-1",
      local: identity.local,
      cloud: identity.cloud,
    })
    expect(again.compositeHash).toBe(identity.compositeHash)
  })

  test("execution target pins run, source, project, and environment", () => {
    const target = buildQcExecutionTarget({
      algorithmId: "algo-1",
      algorithmVersion: 1,
      runId: "run-1",
      runIdentityHash: "a".repeat(64),
      sourceTreeHash: "b".repeat(64),
      projectId: 42,
      projectName: "SPY algo",
      capital: 25000,
    })
    expect(target.environment).toBe("qc_paper")
    expect(target.brokerKind).toBe("qc_paper")
    expect(target.targetHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
