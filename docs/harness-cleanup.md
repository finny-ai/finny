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

## Verification

Run `bun install --frozen-lockfile`, then `bun run typecheck` from the root.
Run tests from their packages; root `bun test` is intentionally disabled.

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
