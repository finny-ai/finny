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
  startWorkflowBacktest,
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
