# TUI subagent task-tray workflow evidence

Date: 2026-07-16

Branch: `codex/tui-subagent-task-tray`

Worktree: `/Users/jaiminpatel/github/finny-folder/finny-internal-prop/.worktrees/tui-subagent-task-tray`

PR: `#185`
Source head used by the primary workflow runtime: `0b8c7d667fa80178b0247e6a64701b6533760270` plus the documented fixes later committed on this branch.

## Acceptance contract

The exercised workflow was:

1. Accept an intentionally vague build request.
2. Ask structured clarification questions before creating a workspace.
3. Create exactly one request-bound workspace and one `WorkflowRun`.
4. Launch the required context agents concurrently in the background.
5. Let the parent do only non-overlapping preparation while context is pending.
6. Wait for all required evidence before synthesis or strategy writes.
7. Save and backtest iterative versions until total return, stitched walk-forward OOS return, and alpha versus same-window buy-and-hold are all positive and the deterministic unified verdict is `recommended_for_paper`.
8. Only after that robust qualification, produce one final review packet for human review, without paper approval.

## Runtime identity

- Isolated runtime root: `/private/tmp/finny-tui-tray-20260716-fixed30`
- Parent session: `ses_092da5944ffejma2ZOF4IusaI0`
- Workflow: `wf_082cda08be529a768bb4e3775f3f3618`
- Workspace slug: `btc-usd-1d-algo.16.7.18.57.778f8b0c`
- Algorithm: `a3543861-f827-4990-9a3a-1fbf82fea569`
- Algorithm name: `btc-daily-adaptive-trend`
- Persistent database: `/private/tmp/finny-tui-tray-20260716-fixed30/data/finny/opencode-local.db`
- User-owned daemon during the workflow run: PID `54448`. It remained alive through implementation, runtime proof, packet generation, and the first commit. It later exited outside the isolated cleanup commands and the user's open TUI started a replacement daemon, PID `39025`, at `19:57:28` local time. Neither user-owned daemon was sent a signal by this workflow.
- The isolated proof used `FINNY_LICENSE_BYPASS=1` only inside its temporary root because the copied license cache was machine-mismatched. Provider authentication, market data, backtests, and review generation remained real.

## Observable conversation and tool sequence

The initiating user message in the session was:

> Build me a strategy that can beat buy and hold; you choose the idea

At `2026-07-16 22:56:55Z`, the clarification boundary returned four answered fields with their selected-option descriptions:

- `BTC.USD crypto 1d`
- `1y, $10k, verified`, resolved to `2025-07-15` through `2026-07-15`
- `Long/flat, DD 15%`, one position, no leverage
- `Strict positive gates`: positive total return, positive stitched OOS return, and positive alpha versus same-window buy-and-hold

At `22:57:39Z`, `finny_workspace_prepare` created exactly one workspace and bound the request identity to workflow `wf_082cda08be529a768bb4e3775f3f3618`.

At `22:57:42Z`, one `task_batch_run` launched both required roles in background mode:

| Role | Session | Created | Finished | Result |
| --- | --- | --- | --- | --- |
| `data_extractor` | `ses_092d96681ffe66rLmpYAuhNFkw` | `22:57:54Z` | `22:59:22Z` | verified |
| `news_agent` | `ses_092d96684ffe3gFzIjsA3BdlT0` | `22:57:54Z` | `23:00:53Z` | verified after same-child correction |

The task rows were created within the same recorded second and both remained in background mode. While they ran, the parent inspected only workspace/template state and explained the locked specification; it did not save, validate, or backtest a strategy. The workflow state records both required evidence objects as `verified` before the research freeze and first strategy candidate.

Verified market-data evidence:

- Source: Binance
- Artifact: `/private/tmp/finny-tui-tray-20260716-fixed30/home/algorithms/a3543861-f827-4990-9a3a-1fbf82fea569/data/crypto/BTC_1d_2025-07-15_2026-07-15.csv`
- Rows: 366
- Coverage: full
- Qualification: strict
- Evidence run: `data_824e13cb20f1ea78`

## Iteration evidence

The persisted `WorkflowRun` contains seven metric attempts, each bound to the same data hash and strict window. The principal runs were:

| Version | Run ID | Total return | Stitched OOS | Alpha vs B&H | Outcome |
| --- | --- | ---: | ---: | ---: | --- |
| v2 | `20260716T232724Z-13ecfa0969e1c20c` | -15.64% | -11.18% | +30.40 pts | rejected |
| v3 | `20260716T233023Z-29f408ed9222e1d6` | -12.67% | -1.12% | +33.37 pts | rejected |
| v4 | `20260716T233213Z-50167b9f87cce9e3` | -10.89% | -8.78% | +35.16 pts | rejected |
| v5 | `20260716T233324Z-db6a829b6fa5efd6` | -1.78% | 0.00% | +44.26 pts | rejected |
| v6 | `20260716T233950Z-46261f5c0fd1d6d1` | +1.95% | 0.00% | +47.99 pts | rejected |
| v7 | `20260716T234114Z-b00c9e940a53138b` | +0.477315% | +0.477315% | +46.523187 pts | positive metrics; robustness failed |

The v7 strategy is a daily long/flat RSI reversal with prior-bar ingestion, next-open execution, no leverage, one position, a protective ATR stop, and a 90% cash-exposure ceiling. Its maximum drawdown was 11.08%, below the requested 15% ceiling.

The unified promotion verdict still failed because this is an exploratory, sparse result with insufficient closed trades. The follow-up robustness stop gate therefore treats v7 as non-terminal: positive metrics alone cannot qualify the WorkflowRun, and a future controlled run must continue iterating until `recommended_for_paper` is reached.

## Review packet

The first packet attempt correctly occurred only after v7 passed the three requested gates, but exposed a persistence bug:

> final review requires a persisted stitched walk-forward OOS return

The strict artifact had the value in `metrics.json.v2.walk_forward`, while the durable BacktestStore manifest had persisted `sourceArtifacts: null`. The fix now publishes strict artifacts before history persistence and safely derives the canonical immutable run directory for pre-fix manifests.

After the repair, the same v7 run hydrated:

- total return: `0.004773154724278861`
- stitched OOS return: `0.004773154724279083`
- alpha: `0.46523187035433056`

Before the robustness stop-gate correction, a `research_complete` packet was generated without rerunning the backtest and without paper approval:

`/private/tmp/finny-tui-tray-20260716-fixed30/home/algos/btc-usd-1d-algo.16.7.18.57.778f8b0c/reviews/btc-v6-2fold-20260716/review.html`

That packet remains historical evidence of the exercised run, not an acceptable terminal packet under the corrected contract. New final-packet generation requires a persisted `recommended_for_paper` run plus positive total return, stitched OOS return, and buy-and-hold alpha. Paper approval remains separate.

## Mismatches found and repaired

- Vague build requests could cross the question boundary without a complete deterministic specification.
- Workspace trust did not consistently prefer answered question state over the original vague text.
- Background task deduplication, delivery, replay, and tray status could disagree; blocked rows could render as successful.
- The parent could enter write/backtest tools before required background context was delivered.
- Required data/news roles were not always launched together or relaunched exactly when missing.
- Malformed news evidence could relaunch a new child rather than correct the same child once.
- Direct history, quote, and web access could duplicate delegated evidence work.
- Interrupted workflows did not reliably resume on a real user continuation.
- Narrative-only continuations could stop before issuing the required next save/backtest tool.
- The old five-failure boundary allowed an active unqualified workflow to stop; it now requires a fresh concept family and continues until the requested gates pass, unless a real hard blocker or user stop occurs.
- Timestamp-unit inference in engine v2 did not cover seconds, milliseconds, microseconds, and nanoseconds robustly.
- Review generation could not hydrate stitched OOS metrics from strict runs whose old manifest lacked `sourceArtifacts`.
- Review exposure notional was initially formatted as a percentage; packet presentation now uses the metric's correct unit.
- Parent/subagent navigation used OpenTUI 0.3.4's `yoga-layout@3.2.1` JavaScript/WASM runtime. Session teardown during terminal resize repeatedly entered Yoga's `StyleValuePool::getNumber` assertion path. The aligned OpenTUI stack is now 0.4.3, which removes the legacy Yoga WASM dependency and includes the upstream teardown/lifecycle fixes.
- After workspace setup, the runtime could prune the main Finny agent to only `read`, task-launch, and todo tools even though its system contract advertised the full Finny surface. The full registered surface now remains visible; unsafe candidate/review actions return typed `launch_required` or `pending` blockers at execution, while safe mission, todo, read, and analysis preparation remains available.
- Final review validation independently allowed a positive-but-sparse `research_complete` run to stop the harness even when the unified robustness verdict failed. Workflow qualification and final-packet eligibility now share one fail-closed stop predicate: `recommended_for_paper` plus positive total return, stitched OOS return, and buy-and-hold alpha. Otherwise the active workflow must keep iterating.
- A provider-fetch research-only run could persist a computed recommendation even though the authoritative WorkflowRun remained unqualified. Final-packet generation now loads the exact WorkflowRun and requires the same session, qualified controller verdict, terminal run ID, and strict identity hash; the authority binding is persisted in the review manifest.

## Observable runtime errors and recoveries

The session database records these non-terminal errors:

- Missing initial `todo.md` and `edge_analysis.md` reads before those workspace artifacts existed.
- One invalid `docsInput.mission` save schema call.
- One aborted save call during interactive recovery.
- One dismissed recovery question.
- One research-brief approval rejection because `unresolvedQuestions` was not empty.
- One refused review packet caused by the strict-artifact persistence bug described above.
- One user-observed BTC 15-minute run exposed the capability mismatch after workspace setup: the model reported only five tools and guessed at unavailable scaffold/write capabilities instead of launching the required evidence batch. This transcript is now covered by the full-visible-surface and execution-gate tests.
- Repeated `Aborted(Assertion failed: handle.type() == StyleValueHandle::Type::Number, ... StyleValuePool.h,73,getNumber)` output occurred when entering or exiting subagent sessions on OpenTUI 0.3.4. The upgraded runtime completed repeated parent/child/sibling navigation without the assertion.

Every error was either corrected in the same workflow or converted into a regression test. No error changed the request identity, created a second workspace, or sent a signal to the user-owned daemon.

## Verification surfaces

- Workflow DB: one workflow, one workspace identity, two required background task rows, verified evidence, seven persisted metric attempts.
- Interactive TUI: real session replay, task tray, continuation, save/backtest loop, and packet generation.
- Phoenix project for the packet retry: `finny-tui-task-tray-20260716`; 11 clean session-attributed spans, including the review tool path, but TUI shutdown did not emit a terminal lifecycle span.
- Phoenix terminal proof project: `finny-tui-task-tray-terminal-proof-20260716`; clean parent/LLM spans plus `finny.run.completed`, with completed telemetry flush. The read-only proof intentionally made no tool call.
- Phoenix grade artifacts: `/tmp/finny-tui-tray-phoenix-grade.json` and `/tmp/finny-tui-tray-terminal-phoenix-grade.json`. The strict grader does not combine complementary projects and therefore reports each partial capture as invalid; the underlying spans are clean and the limitation is explicit here.
- Protected main-agent prompt files were not modified by these fixes; their hashes remained unchanged during implementation and verification.

Final validation in the dirty worktree:

- Core workflow selection: 335 passed, 1 unrelated failure. The failure is the compact data-extractor prompt line-count assertion against an unstaged concurrent prompt edit; this commit does not include that prompt.
- Autonomous-continuation aggregate: 126 passed, 0 failed.
- Review-packet focused suite after the unit fix: 16 passed, 0 failed.
- Engine timestamp/artifact tests: 4 passed, 0 failed.
- TUI tray snapshots: 19 passed, 0 failed.
- TUI notifications: 6 passed, 0 failed.
- `packages/tui` typecheck: passed.
- OpenTUI native-layout dependency guard and 20-cycle keyed parent/subagent teardown-and-resize stress: passed.
- Live OpenTUI 0.4.3 navigation at 200x55 (parent to data child to news sibling to data sibling to parent): passed with no Yoga assertion.
- Full Finny tool visibility plus launch-required, pending-context, verified-admission, and safe-overlap focused regression selection: 101 passed, 0 failed.
- Robust stop-gate, WorkflowRun lifecycle, authoritative review binding, continuation, and context regression selection: 63 passed, 0 failed.
- `git diff --cached --check`: passed.

## Reasoning visibility boundary

This artifact includes user-visible messages, tool inputs and outputs, task lifecycle rows, workflow state, counters, errors, persisted artifacts, and telemetry that the runtime exposed. Full private model reasoning is not exportable. Short reasoning-summary strings stored by the runtime are observable in the session database but are not equivalent to private chain-of-thought.

## Approval boundary

No paper approval or live deployment was requested or performed. The review packet is research evidence for human review. Its sparse-trade and promotion-quality caveats must remain visible when deciding whether to run a better-powered confirmatory experiment.
