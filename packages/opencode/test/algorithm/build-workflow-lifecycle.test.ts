import crypto from "node:crypto"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import {
  completeWorkflowBacktest,
  ensureWorkflowCandidate,
  recordVerifiedMarketData,
  recordWorkflowAttempt,
  startWorkflowBacktest,
  transitionWorkflowIdentity,
} from "@/algorithm/build-workflow/lifecycle"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import type { Algorithm } from "@/algorithm"
import type { BacktestRunner } from "@/backtest/runner"
import * as RunIntegrity from "@/backtest/run-integrity"
import type { VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.defaultLayer)
const hash = (value: string) => RunIntegrity.sha256Text(value)

it.live("drives the single-symbol strict path from verified evidence through a reviewable run", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const workflow = yield* BuildWorkflowStore.insert({
      workflowId: `wf_lifecycle_${suffix}`,
      sessionId: `ses_lifecycle_${suffix}`,
      workspaceSlug: `spy-5m-sma-${suffix}`,
      intent: "build",
      marketDataRequired: true,
      identity: {
        symbols: { value: ["SPY"], source: { kind: "user_message", messageId: `msg_${suffix}` } },
        interval: { value: "5m", source: { kind: "user_message", messageId: `msg_${suffix}` } },
        assetClass: { value: "equity", source: { kind: "user_message", messageId: `msg_${suffix}` } },
        strategyFamily: { value: "sma-crossover", source: { kind: "user_message", messageId: `msg_${suffix}` } },
        window: {
          value: { start: "2026-04-09", end: "2026-07-08" },
          source: { kind: "user_message", messageId: `msg_${suffix}` },
        },
      },
    })
    const dataset = {
      manifestPath: "/tmp/manifest.json",
      manifestSha256: hash("manifest"),
      csvPath: "/tmp/spy.csv",
      csvSha256: hash("dataset"),
      identity: {
        runId: "extractor_run",
        requestedAlgorithmName: "spy-5m-sma",
        requestedSymbol: "SPY",
        actualSymbol: "SPY",
        requestedInterval: "5m",
        actualInterval: "5m",
        requestedAssetClass: "equity",
        actualAssetClass: "equity",
        requestedStart: "2026-04-09",
        requestedEnd: "2026-07-08",
        actualStart: "2026-04-09",
        actualEnd: "2026-07-08",
      },
    } as unknown as VerifiedDatasetRef
    const evidenced = yield* recordVerifiedMarketData({ sessionId: workflow.sessionId, dataset })
    expect(evidenced?.stage).toBe("evidence_ready")

    const algorithm = {
      algorithmId: `algo_${suffix}`,
      userId: "user",
      name: "renamable-label",
      code: "class Strategy:\n    pass\n",
      language: "python",
      version: 1,
      status: "draft",
      config: JSON.stringify({ symbol: "SPY", asset_class: "equity", interval: "5m" }),
      time_created: 1,
      time_updated: 1,
    } satisfies Algorithm.Info
    const candidate = yield* ensureWorkflowCandidate({
      workflow: evidenced!,
      algorithm,
      dataset,
      interval: "5m",
      start: "2026-04-09",
      end: "2026-07-08",
    })
    expect(candidate.workflow.stage).toBe("candidate_ready")

    const running = yield* startWorkflowBacktest(candidate.workflow)
    expect(running.stage).toBe("backtest_running")
    const artifactDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "finny-workflow-run-")))
    const strictIdentity = {
      schema: RunIntegrity.RUN_IDENTITY_SCHEMA,
      version: 1 as const,
      algorithmId: algorithm.algorithmId,
      algorithmVersion: algorithm.version,
      strategyHash: candidate.experiment.strategyHash,
      savedConfigHash: candidate.experiment.savedConfigHash,
      effectiveConfigHash: hash("effective-config"),
      documentHashes: {
        mission: hash("mission"),
        preferences: hash("preferences"),
        decisions: hash("decisions"),
        reasoning: hash("reasoning"),
      },
      riskContractHash: hash("risk"),
      rawDataHash: candidate.experiment.datasetHash,
      processedDataHash: hash("processed"),
      manifestHash: candidate.experiment.manifestHash,
      engineTreeHash: hash("engine-tree"),
      assetProfileHash: hash("asset-profile"),
      executionProfileHash: hash("execution-profile"),
      seed: 42,
      dateWindow: { start: "2026-04-09", end: "2026-07-08", interval: "5m" },
    }
    const strictIdentityHash = RunIntegrity.sha256Text(RunIntegrity.stableStringify(strictIdentity))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(artifactDir, "run.json"),
        JSON.stringify({
          schema: RunIntegrity.RUN_BUNDLE_SCHEMA,
          version: 1,
          runId: "run_strict",
          identity: strictIdentity,
          identityHash: strictIdentityHash,
        }),
      ),
    )
    const reviewable = yield* completeWorkflowBacktest({
      workflow: running,
      experiment: { ...candidate.experiment, workflow: running },
      results: {
        runId: "run_strict",
        engineVersion: "engine_v2",
        artifactDir,
      } as BacktestRunner.Results,
      verdict: "recommended_for_paper",
    })
    expect(reviewable).toMatchObject({
      stage: "reviewable",
      backtest: {
        runId: "run_strict",
        dataHash: hash("dataset"),
        hashes: {
          strategyHash: expect.any(String),
          savedConfigHash: expect.any(String),
          effectiveConfigHash: expect.any(String),
          dataHash: hash("dataset"),
          manifestHash: hash("manifest"),
          engineHash: hash("engine-tree"),
          strictRunIdentityHash: strictIdentityHash,
          windowHash: expect.any(String),
        },
        verdict: "recommended_for_paper",
      },
    })
    expect(reviewable.backtest?.identityHash).toMatch(/^[a-f0-9]{64}$/)
    yield* Effect.promise(() => fs.rm(artifactDir, { recursive: true, force: true }))
  }),
)

it.live("resumes crash-between-begin-and-finish attempts for task, save, and backtest", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const workflow = yield* BuildWorkflowStore.insert({
      workflowId: `wf_resume_${suffix}`,
      sessionId: `ses_resume_${suffix}`,
      workspaceSlug: `spy-resume-${suffix}`,
      intent: "build",
      identity: { symbols: { value: ["SPY"], source: { kind: "user_message", messageId: `msg_${suffix}` } } },
    })
    for (const operation of ["task:data_extractor", "finny_algorithm_save", "finny_backtest"]) {
      const fingerprint = `${operation}:fingerprint`
      const input = {
        sessionId: workflow.sessionId,
        operation,
        fingerprint,
        idempotencyKey: `${operation}:begin:${fingerprint}`,
        outcome: "accepted" as const,
      }
      expect(yield* recordWorkflowAttempt(input)).toMatchObject({ allowed: true, disposition: "recorded" })
      expect((yield* BuildWorkflowStore.get(workflow.workflowId))?.attempts.at(-1)).toMatchObject({
        operation,
        lifecycle: "in_progress",
      })
      expect(yield* recordWorkflowAttempt(input)).toMatchObject({ allowed: true, disposition: "resumed" })
      expect(
        yield* recordWorkflowAttempt({
          sessionId: workflow.sessionId,
          operation: `${operation}:finish`,
          fingerprint,
          idempotencyKey: `${operation}:finish:${fingerprint}:failed`,
          outcome: "failed",
          lifecycle: "terminal",
          blockerCode: `${operation}:execution_failed`,
          requiredChanges: ["resolve the thrown tool or preflight error"],
        }),
      ).toMatchObject({ allowed: true })
      expect(yield* recordWorkflowAttempt(input)).toMatchObject({
        allowed: false,
        code: "unchanged_blocker_retry_denied",
      })
    }

    const fingerprint = "finny_backtest:terminal-fingerprint"
    yield* recordWorkflowAttempt({
      sessionId: workflow.sessionId,
      operation: "finny_backtest",
      fingerprint,
      idempotencyKey: `finny_backtest:begin:${fingerprint}`,
      outcome: "accepted",
    })
    yield* recordWorkflowAttempt({
      sessionId: workflow.sessionId,
      operation: "finny_backtest:finish",
      fingerprint,
      idempotencyKey: `finny_backtest:finish:${fingerprint}:blocked`,
      outcome: "blocked",
      lifecycle: "terminal",
      blockerCode: "backtest_preflight_rejected",
      requiredChanges: ["config"],
    })
    expect(
      yield* recordWorkflowAttempt({
        sessionId: workflow.sessionId,
        operation: "finny_backtest",
        fingerprint,
        idempotencyKey: `finny_backtest:begin:${fingerprint}`,
        outcome: "accepted",
      }),
    ).toMatchObject({ allowed: false, code: "unchanged_blocker_retry_denied" })
  }),
)

it.live("keeps parser-proposed symbols request-bound until structured identity confirmation", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const workflow = yield* BuildWorkflowStore.insert({
      workflowId: `wf_proposed_${suffix}`,
      sessionId: `ses_proposed_${suffix}`,
      workspaceSlug: `spy-proposed-${suffix}`,
      intent: "build",
      identityStatus: "proposed",
      marketDataRequired: true,
      identity: {
        symbols: {
          value: ["SPY"],
          source: { kind: "parser_proposal", messageId: `msg_${suffix}`, confidence: 0.5, parser: "request_identity_v2" },
        },
      },
    })
    expect(workflow).toMatchObject({ stage: "request_bound", phase: "identity_proposed" })
    const dataset = {
      manifestSha256: hash("proposed-manifest"),
      identity: { actualSymbol: "SPY", runId: "proposed_run" },
    } as unknown as VerifiedDatasetRef
    const blocked = yield* Effect.exit(recordVerifiedMarketData({ sessionId: workflow.sessionId, dataset }))
    expect(blocked._tag).toBe("Failure")
    expect(
      yield* BuildWorkflowStore.append({
        workflowId: workflow.workflowId,
        expectedRevision: workflow.revision,
        event: {
          id: `evt_proposed_complete_${suffix}`,
          type: "workflow.completed",
          occurredAt: Date.now(),
          source: { actor: "system" },
        },
      }),
    ).toMatchObject({ kind: "rejected", decision: { code: "identity_unconfirmed" } })

    const source = { kind: "structured_tool" as const, tool: "finny_workspace_prepare", callId: "call_confirm" }
    const confirmed = yield* transitionWorkflowIdentity({
      sessionId: workflow.sessionId,
      source: { actor: "tool" },
      reason: "structured confirmation",
      identity: { symbols: { value: ["SPY"], source } },
    })
    expect(confirmed).toMatchObject({ identityStatus: "confirmed", phase: "identity_confirmed" })
    expect((yield* recordVerifiedMarketData({ sessionId: workflow.sessionId, dataset }))?.phase).toBe("evidence_ready")
  }),
)
