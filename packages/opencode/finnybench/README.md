# FinnyBench trajectory regressions

This directory defines the normalized contract between provider-backed Finny runs and the deterministic
FinnyBench grader. It tests the whole harness trajectory without exposing held-out prompts or verifier
answers to the evaluated model.

## Boundaries

- `trajectory-suite.json` is public task metadata. It contains scenario IDs, prompt hashes, provider
  configuration hashes, terminal expectations, deterministic assertion names, and budgets. It does not
  contain held-out prompt text, canary values, data snapshots, or grader evidence.
- Held-out prompts and frozen data live in the private capture system. Before a run, the capture system
  must hash the exact prompt, provider configuration, and data snapshot and put those hashes in the
  normalized trajectory.
- `src/finnybench/trajectory-grader.ts` is deterministic and offline. Qualitative model grading can be
  attached downstream, but it cannot change this grader's pass/fail result.
- The grader never writes baselines. Passing `--baseline` compares reviewed scores and fails when a run is
  new, missing, or changed, forcing an intentional baseline update through review.

## Normalized trajectory

Capture adapters write `finnybench.trajectory.v1` JSON or JSONL. Every record includes:

- pinned prompt, model, provider configuration, data snapshot, and harness revision;
- terminal class and summary;
- request identity snapshots from each session/artifact boundary;
- evidence attempts and provenance clocks;
- tool calls, repeated-task keys, child lifecycle, artifacts, and persistence roots;
- input, cached input, reasoning, output, latency, and estimated cost;
- one trace tree with redacted payloads;
- strategy-quality fields only when a valid backtest exists.

Terminal correctness, harness invariants, strategy quality, budgets, and reproducibility are separate grade
dimensions. A packaging failure therefore cannot be reported as provider or data unavailability, and an
expected evidence blocker can pass terminal grading without receiving a strategy-quality score.

## Commands

From `packages/opencode`:

```bash
bun run finnybench:trajectory:smoke

bun run finnybench:quality:smoke

bun run script/finnybench-trajectory.ts \
  --suite finnybench/trajectory-suite.json \
  --input /private/captures/full.jsonl \
  --require-subset full \
  --baseline /private/baselines/accepted.json
```

The smoke command is offline and cheap enough for pull requests. The full command requires every scenario
for both the pinned Gemini and OpenAI-compatible provider profiles. The scheduled workflow downloads the
private capture bundle through a configured repository variable and grades it without printing prompt text
or credentials.

## Harness-output quality regression gate

`quality-gate.json` defines the reviewed warning and failure deltas for the four issue #43 aggregates:
median excess Sharpe versus the same-window benchmark, share beating buy-and-hold, share clearing the
exploratory gate, and median closed-trade count. Warning thresholds keep the workflow green while making a
smaller drift visible. Failure thresholds exit non-zero.

The gate compares exact cohorts. A cohort is keyed by task, provider, model, and repetition, and its task,
provider-configuration, and data-snapshot hashes must match the accepted baseline. Missing, new, duplicate,
or repinned cohorts fail closed instead of creating a misleading comparison. The minimum of eight
observations bounds noise; the scheduled capture should use at least two tasks, two provider profiles, and
two repetitions. Updating an accepted baseline is a separately reviewed operation, never something the
grader does.

Pull requests run `quality-baseline.synthetic.jsonl` against `quality-candidate.synthetic.jsonl`. These
small committed fixtures exercise aggregation, thresholds, pin enforcement, reporting, and failure
behavior with zero provider cost. They are deliberately labeled `synthetic_pinned` and are not a claim
about current harness performance.

The scheduled lane downloads both a normalized provider-backed capture and its accepted baseline from
immutable private URLs:

- `FINNYBENCH_FULL_ARTIFACT_URL` points at current trajectories produced from the fixed suite and pinned
  snapshots.
- `FINNYBENCH_QUALITY_BASELINE_URL` points at the reviewed accepted observations or trajectories.
- `FINNYBENCH_ARTIFACT_TOKEN` authorizes both downloads.

The trajectory grader also receives `--require-harness-revision $GITHUB_SHA`. A capture for another
commit is rejected before scoring, so a mutable “latest” URL cannot silently turn a stale run into current
CI evidence.

Every valid-backtest trajectory used for quality grading must include `quality_evidence_class`,
`repeat`, strategy and benchmark Sharpe/total return, `exploratory_gate_passed`, and `closed_trades` in
`strategy_quality`. The quality runner can also read normalized `finnybench.quality-observation.v1`
JSONL directly. It emits a machine-readable report, a GitHub step summary, and a 90-day workflow artifact;
the PR smoke lane updates one marker-scoped comment with the synthetic deltas.

All reports set `interpretation` to `benchmark_evidence_only` and `promotion_eligible` to `false`.
Provider-backed benchmark results still do not establish live alpha, paper eligibility, or deployment
approval.

## Capture adapter requirements

The provider runner is intentionally outside this repository so held-out material cannot leak into public
task contracts. Its output adapter must:

1. Create a fresh state root per run and record the exact Git revision.
2. Run each scenario once for every provider profile in the suite.
3. Normalize runtime-owned SQLite, artifact, tool, child-session, usage, and trace records into JSONL.
4. Redact secrets before serialization and include the scoped canary observations needed by the canary gate.
5. Upload the JSONL bundle to the private URL configured as `FINNYBENCH_FULL_ARTIFACT_URL`.

The workflow uses `FINNYBENCH_ARTIFACT_TOKEN` only as a bearer token for that download. Neither value is
passed to Finny or included in grader output.
