# Native LEAN backend for Crucible (v1)

## What this is

QuantConnect LEAN becomes a version-pinned execution backend for Finny
Crucible. Crucible stays authoritative for dataset admission, experiment
plans, trial budgets, sealed holdouts, canonical metrics, verdicts, and
review packets. LEAN never decides eligibility.

## Runtime profiles

- `finny_python` — existing `engine_v2` path. Default for every saved
  algorithm; nothing changes for existing records.
- `lean_python` / `lean_csharp` — opt-in LEAN runtimes. Saved through
  `finny_algorithm_save` with `runtimeProfile` plus a `strategySource` file
  manifest (`path` + `sha256` + `bytes` for every project file). The manifest
  is bound into the config, the plan, and the run identity.

LEAN candidates are real `QCAlgorithm` projects (Python or C#). Finny does
not translate Shape-C strategies; each runtime has its own first-class
authoring contract. Changing runtimes requires a new algorithm name/version.

## Execution posture

Every LEAN run:

1. Is derived from Finny-attested strict evidence (raw-basis, resolved
   corporate actions, no repair lineage, complete calendars). Fill-forward is
   disabled and the worker schedule must match the plan's schedule hash.
2. Runs the pinned `ghcr.io/finny-ai/lean-engine` image at a digest pinned in
   `src/backtest/lean/contracts.ts` via the raw LEAN launcher — never the
   LEAN CLI, never QuantConnect Cloud/data, no network, no secrets.
3. Executes in a non-root, read-only, capability-dropped container with
   controller-owned CPU/memory/PID/wall-clock/log/artifact limits.
4. Emits canonical artifacts (`orders.csv`, `fills.csv`, `rejections.csv`,
   `equity.csv`, `results.json`) that the strict run publisher consumes.
5. Feeds only canonical `CrucibleResultV1` fields into qualification gates;
   raw LEAN statistics are evidence-only and never promotable.

The feature flag `FINNY_LEAN_ENABLED=1` plus the adapter certificate
(`FINNY_LEAN_ADAPTER_CERT=finny-lean-adapter-cert-v1`) and a verified pinned
image are all required before any execution. Everything else fails closed
with a typed blocker; there is no engine fallback.

## Rollout gates

- Supply-chain: pinned digest + commit, SBOM, provenance, signature, license
  inventory, offline sandbox, deterministic config hash.
- Parity: identical bar schedules (zero fill-forward), canonical order/fill
  sequences matching certified `engine_v2` fixtures, LEAN Python == LEAN C#
  == engine_v2 metrics within canonical precision, and 3 identical reruns.
- Validation gate: LEAN may run exploratory/validation only after the full
  certificate is current for the exact image digest.
- Confirmatory/holdout gate: additionally requires a current determinism
  certificate, V2 plan binding of every engine/data/model hash, prior workers
  that never received confirmatory bytes, and exactly one approved holdout
  open event.
- Review gate: `recommended_for_paper` requires canonical results, the
  immutable run bundle, the existing statistical gates, integrity
  verification, and the final review packet.

LEAN paper/live deployment is explicitly unsupported in v1: `finny_paper_approve`
and live deployment stay blocked for LEAN runtimes.

## Known v1 boundaries

Fixed universes of up to 20 symbols, single asset family per plan (equity or
spot crypto), minute/hour/daily, market/limit/stop-market orders, Finny-led
sweeps and walk-forward trials (LEAN's standalone optimizer deferred),
local Docker execution with a hosted-compatible job contract, and no dynamic
or fundamental universes.

## Algorithm control plane

Algorithms are first-class control-surface objects, not just chat artifacts.
The `algo` CLI exposes the full lifecycle so a firm can store, inspect, and
operate strategies without an agent conversation:

- `algo list` / `algo show <name>` / `algo versions <name>` — browse saved
  algorithms and every immutable version.
- `algo add --name X --file strategy.py --runtime-profile lean_python` — store
  an algorithm from a file. Runtime profiles are honored: `finny_python`
  (default engine_v2), `lean_python` (real QCAlgorithm `main.py` persisted as
  the version's LEAN source), and `lean_csharp` (source-manifest required).
  `--save-mode version --docs-mode replace` bumps an existing version.
- `algo validate` / `algo backtest` — runtime-aware: LEAN candidates skip the
  Shape-C AST validator and run the pinned container through the same strict
  gate as the chat flow.
- `algo open <name>` — the navigation verb: prints the version directory,
  backtest store, review packets, and LEAN source tree, and reveals the
  version directory in the OS file manager.

Every stored version keeps the same contract as a chat save: config hash,
runtime profile, source manifest, mission/risk documents, and run identity.
The QuantConnect Cloud track (posting strategies to QC projects/backtests/live
deployments for firms that bring their own QC entitlements) extends this
control plane with `qc_cloud` deployment verbs and its own result schema;
it never merges into the local LEAN or engine_v2 schemas.
