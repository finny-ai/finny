# Harness cleanup

This change keeps the research-to-strategy-to-validation-to-backtest-to-
qualification-to-review pipeline, its CLI/TUI, HTTP API, provider adapters,
workspace persistence, SDK/plugin interfaces, and embedded web client.
Data integrity, runtime-owned experiment identity, and human financial approval
remain enforced in code.

## Removed scope

| Group | Reason and retained boundary |
| --- | --- |
| Console, stats/lake, marketing/docs site, enterprise/share host, Cloudflare API, SST infrastructure | Separate hosted products and deployments. This deliberately retires the console's Finny `/live` page and local share hosts; ledger/execution APIs, monitoring, and remote share/import clients remain. No production deployment or remote data is changed by this PR. |
| Electron desktop, Slack, Storybook, Nix packaging, local GitHub Action source | Separate launchers, integrations, and development/distribution surfaces. The Finny npm/installer release path, SDK, CLI GitHub commands, and embedded client remain. |
| Archived workflows and their upstream-only helpers | Files outside `.github/workflows` cannot execute as active workflows. Keep active Finny release, harness, benchmark, and unit/typecheck workflows. |
| Legacy `finny-integrations` / `finny-registry` tool registration and exports | Not registered by the shipped CLI, runtime, plugins, or current tool registry. This intentionally retires their private legacy deep-import APIs; active broker/data tools and financial guards remain. |
| Orphan utilities, generated provider snapshot, unused Convex adapters | Resolved consumers and runtime discovery were checked. Keep generated catalog injection, local storage, subscription/telemetry adapters, and scheduled-job persistence. |
| Detached ETH/USO presets, downloaded CSV, request-specific research notes | Not selected by product templates or harness scenarios. Keep meaningful fixtures, the locked Python runtime, all engine code, and `strategy.py`, whose interfaces are dynamically consumed by the v1 compatibility adapter. |

The primary prompt now delegates parameter manuals to tool descriptions while
retaining evidence, context handoff, validation, qualification, review, and
structured approval rules. Legacy Build guidance follows the same current
qualification contract. Validator warnings still block saving; the unreachable
advisory-success text has been removed.

The default CLI build still embeds `packages/app`. Removing it or the shared
UI/provider/storage packages would require a separate change to the harness's
client and build contracts.

A live-model verification exposed an identity bug: a complete `BTCUSDT` request
could be parsed as the indicator `SMA20`, blocking workspace creation. Identity
parsing now preserves full recognized pairs, rejects indicator lookbacks in
unlabeled prose, confirms normalized aliases and supported compact slugs, and
keeps explicit multi-asset universes intact. Workspace binding rejects silent
narrowing or expansion of that universe. Explicit ticker labels remain supported.

## Verification

Run `bun install --frozen-lockfile`, then `bun run typecheck` from the root.
Run tests from their packages; root `bun test` is intentionally disabled.
The GitHub `test` workflow was manually disabled when inspected; changing its
branch filter does not enable that host setting. Local unit results below are
separate from active build/typecheck/harness CI.

```sh
bun --cwd packages/opencode test --timeout 30000 \
  test/agent/finny-debloat.test.ts test/tool/registry.test.ts \
  test/tool/algorithm-save-python-missing.test.ts \
  test/harness/headless-harness.test.ts test/harness/headless-fixtures.test.ts \
  test/backtest/qualification-operation.test.ts \
  test/backtest/final-review-packet.test.ts

PYTHONPATH=packages/opencode uv run --frozen --project packages/opencode/python \
  --python 3.12 pytest -q packages/opencode/tests/engine_v2

MODELS_DEV_API_JSON="$PWD/packages/opencode/test/tool/fixtures/models-api.json" \
  bun packages/opencode/script/build.ts --single --skip-install
```

For a reproducible isolated full workflow, start the pinned Phoenix collector
(`arizephoenix/phoenix:version-17.22.0`) on a free loopback port, commit the
candidate, and run:

```sh
bun packages/opencode/script/headless-harness.ts \
  --ref HEAD --model harness/scripted --agent finny \
  --scenario packages/opencode/harness/scenarios/spy-5m-sma-positive-qualification.v1.json \
  --fixture positive_qualification --collector http://127.0.0.1:6006 \
  --output .artifacts/cleanup-positive
```

The resulting manifest, raw events, checksums, strict run artifacts, and final
review packet provide evidence of actual CLI/tool/engine execution. Scripted
model and market inputs are synthetic, so this proves workflow behavior rather
than live model quality, live market performance, or broker execution. A live
provider run must be reported separately with its own evidence and limitations.

## Recorded acceptance, 2026-10-05

The final runtime commit is `119bbf41889468f82bf54b9952b7613167cb34ba`. The acceptance workflow runs
that exact committed source in a detached frozen installation with fresh runtime
state. Any following documentation commit leaves runtime code identical.

Measured removal: 1,810 files / 61,489,662 bytes.
The main prompt changes from 2,492 to 994 whitespace-separated words.

| Check | Result |
| --- | --- |
| Frozen Bun installation and workspace typecheck | Pass; 14 typecheck tasks |
| Native CLI build with embedded app and binary version smoke | Pass on the final runtime commit |
| Focused CLI regressions | 409 passed across 39 files, 0 failures |
| Core package tests | 112 passed, 0 failures |
| Locked Python engine suite | 264 passed; 639 warnings retained |
| Final positive qualification scenario `20261005061519-2e217d3015` | `completed`, exit 0; all 9 required stages, no violations/errors |
| Earlier losing-strategy scenario `20261005051234-289d392742` | `completed`, exit 0; failed strategy verdict, no promotion |
| Final positive artifact/index/checksum verification | 83 artifacts, 110 source mappings, 85 checksum entries passed |
| Final positive Phoenix evidence | 29 attributed spans, 0 unattributed; complete pagination/flush, valid grade |
| Final runtime PR CI | All applicable checks passed; live-provider jobs skipped |

The losing-strategy run used deletion commit `b70b5596bcd89ff998cf18c0f324acb5df5dd378`; engine
code remains unchanged. Its 45 artifact hashes also passed verification. Raw
bundles are local ignored `.artifacts/cleanup-positive-acceptance/` and
`.artifacts/cleanup-negative/`. Python package fingerprints match before and
after the final acceptance run.

Independent deletion/source, identity, and evaluator reviews found no unresolved
blocking issue in their scope. Two test corrections preserve production behavior:
sharing uses the fixture's database rather than another empty in-memory database;
its four failures reproduced on the untouched base. The hourly-calendar test
expects a missing-bar rejection even above the coverage threshold; the exact
Python fixture reproduced that rejection on the base. Neither changes a
production gate. A concurrent verification attempt hit explicit ENOSPC errors;
the affected checks passed on retry.

The accepted qualification workflow uses scripted model and synthetic market
inputs, including fixture sealed-holdout approval. It proves actual CLI, tools,
engine, qualification, and review behavior. It does not prove market edge, live
trading, or financial authorization. No paper/live execution approval or broker
order tool was called. The archive includes embedded qualification records but
omits some standalone plan/workflow/policy/context records; complete offline
strict-bundle revalidation remains unavailable.

Live-provider evidence is separate. A Kilo Auto Free run completed a real Binance
BTCUSDT/BTC-USD historical backtest, 2026-01-01 through 2026-02-28. Its captured
strict metrics were return -1.26%, Sharpe -1.49, max drawdown 3.22%, and 12 closed
trades; the strategy failed its research quality gates. That run's evaluator
rejected legacy/structured document and spot-alias mismatches plus an unapproved
read-error recovery. The document/alias mismatches were fixed and independently
replayed; the original bundle remains a failed acceptance attempt.

A following Kilo Auto run returned an explicit upstream service-overload error.
The final Step 3.7 Flash attempt returned `contract_failed`: the model did not save
or backtest a candidate and its missing-field, delegation, and read-error
violations remain failures. Clean live-provider acceptance is **not established**.
Initial credit/authentication/subscription/model rejections are also retained
as failed attempts, not runtime acceptance.

Isolated live source execution disables catalog fetching and starts with an empty
cache. Provide an explicit current provider/model definition through
`FINNY_HARNESS_CONFIG_CONTENT` and supply credentials privately. No credentials
or raw provider bundles are committed. The GitHub unit-test workflow is manually
disabled at the host; local unit results above do not imply that it ran in CI.
