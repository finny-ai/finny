import { describe, expect, test } from "bun:test"
import { BacktestRunner } from "../../src/backtest/runner"
import { qualificationInputForResearch } from "../../src/backtest/qualification-policy"
import {
  authoritativeBacktestInputIssue,
  BacktestParameters,
  backtestAttemptFingerprint,
  backtestDataSourceSummary,
  experimentInputForBacktest,
  resolveBoundBacktestDates,
} from "../../src/tool/backtest"

describe("backtest data selection", () => {
  test("changes the durable retry fingerprint when request or evidence changes", () => {
    const params = { algorithmName: "xrp-1d-strategy", interval: "1d", duration: "1y" }
    const provider = backtestAttemptFingerprint({ params, requestVersion: 1 })
    const newerRequest = backtestAttemptFingerprint({ params, requestVersion: 2 })
    const verified = backtestAttemptFingerprint({
      params,
      requestVersion: 1,
      evidence: { manifestSha256: "a".repeat(64), csvSha256: "b".repeat(64) },
    })

    expect(new Set([provider, newerRequest, verified]).size).toBe(3)
  })

  test("changes the durable retry fingerprint when a saved candidate version changes", () => {
    const params = { algorithmName: "btc", interval: "1d", duration: "1y" }
    const candidate = { algorithmId: "algo_btc", version: 1, code: "def on_bar(): pass", config: "{}" }
    const v1 = backtestAttemptFingerprint({ params, requestVersion: 1, candidate })
    const v2 = backtestAttemptFingerprint({
      params,
      requestVersion: 1,
      candidate: { ...candidate, version: 2, code: "def on_bar(): return 'buy'" },
    })
    expect(v1).not.toBe(v2)
  })

  test("uses provider fetch as the normal Crucible source while keeping promotion qualification separate", () => {
    expect(
      BacktestRunner.qualificationDataSourceIssue({
        engineMode: "strict_v2",
        sessionID: "ses_research",
        dataSource: { kind: "provider_fetch" },
      }),
    ).toBeUndefined()
    expect(
      BacktestRunner.qualificationDataSourceIssue({
        engineMode: "strict_v2",
        sessionID: "ses_qualification",
        dataSource: { kind: "provider_fetch" },
        qualification: qualificationInputForResearch(),
      }),
    ).toContain("Qualification requires")
    expect(backtestDataSourceSummary({ kind: "provider_fetch" })).toBe(
      "Data source: Crucible-managed provider pipeline (strict collection and quality validation)",
    )
  })

  test("exposes no repaired-data mode in the user-facing backtest schema", () => {
    expect(Object.keys(BacktestParameters.shape)).not.toContain("dataQualityMode")
    expect(Object.keys(BacktestParameters.shape)).not.toContain("repairOutliersApproved")
    expect(JSON.stringify(BacktestParameters)).not.toContain("repair_outliers")
  })

  test("does not label research-only verified evidence as qualification eligible", () => {
    expect(backtestDataSourceSummary({ kind: "verified_artifact", qualification: "research_only" })).toContain(
      "research-only, qualification/promotion disabled",
    )
    expect(backtestDataSourceSummary({ kind: "verified_artifact", qualification: "strict_qualified" })).toContain(
      "strict qualification eligible",
    )
  })

  test("uses the prepared workflow window when the backtest call only supplies duration", () => {
    expect(
      resolveBoundBacktestDates({
        params: {},
        workflowWindow: { start: "2025-07-15", end: "2026-07-15" },
        requestSpecWindow: { start: "2025-07-16", end: "2026-07-16" },
      }),
    ).toEqual({ startDate: "2025-07-15", endDate: "2026-07-15" })
  })

  test("keeps the confirmed workflow dates authoritative", () => {
    expect(
      resolveBoundBacktestDates({
        params: { startDate: "2024-01-01", endDate: "2024-12-31" },
        workflowWindow: { start: "2025-07-15", end: "2026-07-15" },
      }),
    ).toEqual({ startDate: "2025-07-15", endDate: "2026-07-15" })
  })

  test("rejects attempts to shift a confirmed evaluation window or interval", () => {
    expect(
      authoritativeBacktestInputIssue({
        params: { startDate: "2025-07-18", endDate: "2026-07-15", interval: "1d" },
        workflowWindow: { start: "2025-07-15", end: "2026-07-15" },
        workflowInterval: "1d",
      }),
    ).toContain("conflicts with confirmed workflow start")
    expect(
      authoritativeBacktestInputIssue({
        params: { startDate: "2025-07-15", endDate: "2026-07-15", interval: "1h" },
        workflowWindow: { start: "2025-07-15", end: "2026-07-15" },
        workflowInterval: "1d",
      }),
    ).toContain("conflicts with confirmed workflow interval")
    expect(
      authoritativeBacktestInputIssue({
        params: { startDate: "2025-07-15", endDate: "2026-07-15", interval: "1d" },
        workflowWindow: { start: "2025-07-15", end: "2026-07-15" },
        workflowInterval: "1d",
      }),
    ).toBeUndefined()
    // Tool schema uses display form ("5min"); workflow identity is canonical ("5m").
    expect(
      authoritativeBacktestInputIssue({
        params: { startDate: "2026-01-09", endDate: "2026-07-08", interval: "5min" },
        workflowWindow: { start: "2026-01-09", end: "2026-07-08" },
        workflowInterval: "5m",
      }),
    ).toBeUndefined()
  })

  test("isolates provider-fetched Crucible runs from unrelated experiment snapshots", () => {
    const left = experimentInputForBacktest({
      dataSourceKind: "provider_fetch",
      sessionId: "ses_left",
      fingerprint: "same-request",
    })
    const right = experimentInputForBacktest({
      dataSourceKind: "provider_fetch",
      sessionId: "ses_right",
      fingerprint: "same-request",
    })
    expect(left?.experimentId).toStartWith("exp-research-")
    expect(left?.experimentId).not.toBe(right?.experimentId)
    expect(
      experimentInputForBacktest({
        dataSourceKind: "verified_artifact",
        sessionId: "ses_left",
        fingerprint: "qualified",
      }),
    ).toBeUndefined()
  })
})
