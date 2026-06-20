# Upstream sync playbook

Finny is a long-lived fork of [anomalyco/opencode](https://github.com/anomalyco/opencode).
This document is the contract for keeping the fork in sync without losing Finny
behavior. It has three parts: the cadence/process, the divergence ledger (which
upstream files we deliberately modify and what invariant each modification
carries), and the conflict-resolution rules.

## Process

- **Remote layout**: `origin` = this fork, `upstream` = `https://github.com/anomalyco/opencode.git`.
  Sync target branch is `dev` (upstream) → `dev`/`staging-dev` (fork).
- **Cadence: sync small, sync often.** A weekly merge is dozens of conflicts;
  a quarterly merge is thousands of files (PR #43 was 3,549 files because the
  fork lagged months behind). The scheduled workflow
  (`.github/workflows/upstream-sync.yml`) attempts a merge weekly and opens a
  PR when clean, or an issue listing conflicts when not.
- **Always `git merge upstream/dev`, never rebase.** The fork's history is
  shared across three sibling clones (`finny`, `finny-internal`,
  `finny-internal-prop`); rebasing rewrites shared history.
- **Enable rerere once per clone**: `git config rerere.enabled true`.
  Re-recorded resolutions replay automatically on the next sync.
- **Run the helper**: `./script/sync-upstream.sh` fetches upstream, creates
  `sync/upstream-<date>`, merges, and prints conflicts grouped by ledger entry.
- **Propagation between clones is manual.** Land the sync in one repo, then
  push the same merge commit to the siblings (`finny`, `finny-internal`,
  `finny-internal-prop` differ only in README/license and CI enablement).

## Verification gate (every sync PR)

1. `bun install` (lockfile/catalog conflicts resolve toward upstream's catalog
   versions unless a Finny package pins something — see ledger).
2. `bun run typecheck` from the repo root.
3. `cd packages/opencode && bun test` — the Finny suites that must stay green:
   `test/agent/finny-*.test.ts`, `test/tool/shell-data-agent.test.ts`,
   `test/tool/extract-data.test.ts`, `test/tool/task.test.ts`,
   `test/plugin/finny-workspace.test.ts`, plus the tool suites
   (`shell`, `read`, `edit`, `write`).
4. Launch the TUI once (`bun run dev`) and confirm the Finny splash, the three
   agent modes, and Settings → Data Sources render.

## Divergence ledger

Rule of thumb when resolving any conflict: **upstream wins on structure,
Finny wins on behavior.** Take upstream's version of moved/renamed/refactored
code, then re-apply the Finny invariant listed here onto the new structure.

### Finny-only surfaces (no upstream counterpart — keep ours wholesale)

- `packages/finny-core/`, `packages/finny-integrations/`, `packages/finny-registry/`
- `packages/opencode/src/agent/prompt/finny-*.txt`
- `packages/opencode/src/agent/finny-workspace-context.ts`, `src/agent/request-identity.ts`
- `packages/opencode/src/tool/finny-workspace-guard.ts`
- `packages/opencode/src/tool/algorithm-*.ts`, `backtest-*.ts`, `portfolio-backtest.ts`,
  `price-history.ts`, `quote.ts`, `brokerage-switch.ts`, `discord.ts`
- `packages/opencode/src/algorithm/`, `src/backtest/`, Python pieces
  (`backtest.py`, `strategy.py`, `algorithm/*.py`, `fetch_binance_klines.py`)
- `convex/`, `packages/opencode/src/storage/convex/`
- `algos/_template/`, `data-agent/instructions.md`
- `packages/opencode/test/agent/finny-*.test.ts`, `test/tool/shell-data-agent.test.ts`,
  `test/plugin/finny-workspace.test.ts`

### Upstream files carrying Finny modifications (conflict hotspots)

| File | Finny invariant to preserve after every sync |
| --- | --- |
| `packages/opencode/src/agent/agent.ts` | The Finny agent roster (`build`, `research`, `chat`, `portfolio_builder`, `data_extractor`, `researcher`) with `finnyFileSystemSandbox`, `finnyToolBundle`, template/news/mission access bundles, `finnySecretReadDeny`, `finnySessionDataReadAccess` (build can read user algo `data/`). No `steps` budgets (removed in PR #40). `data_extractor` uses `finnyToolBundle(["bash", "read"])`. **Drop upstream's `plan` agent** — Finny exposes only build/research/chat as primary modes; upstream re-adds plan on most syncs. The matching `agent.test.ts` plan tests must be removed and any `default_agent: "plan"` fixtures retargeted to `chat`. |
| `packages/opencode/src/tool/shell.ts` (was `bash.ts`) | Tool ID stays `"bash"`. Data-agent guards: a bound session workspace is **required** before any `data_extractor` bash runs (else "Data Agent bash blocked: no session workspace is bound"); `assertDataExtractorWrites` / `assertDataExtractorReads` wrap execute; `dataExtractorDataRoot` defaults `cwd` to the workspace data root; `.env` loading + `FINNY_*`/`ALLOWED_DATA_DIR` env injection for `data_extractor`. |
| `packages/opencode/src/tool/read.ts` | `findFinnyAlgoRoot` / `resolveReadPath` (algos + data-agent path anchoring), `assertDataExtractorRead`, `assertResearcherWorkspaceNewsPath` call. |
| `packages/opencode/src/tool/edit.ts`, `write.ts` | `resolveReadPath` for the file path + `assertResearcherWorkspaceNewsPath(ctx, path, "edit"/"write")`. |
| `packages/opencode/src/tool/task.ts` | Workspace inheritance (`bindSessionWorkspace` parent→child), `withFinnySubagentContext` prompt wrapping, `syncWorkspaceRequestContext` for `data_extractor`/`researcher`. |
| `packages/opencode/src/tool/registry.ts` | Finny tools registered (algorithm/backtest/quote/price-history/portfolio/discord); **no** `extract-data` tool (deleted; data agent uses bash recipes). |
| `packages/opencode/src/session/prompt.ts` | No step-budget enforcement (no `MAX_STEPS`/`isLastStep`); Finny prompt assembly (`finny-build` switch, reminders). |
| `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` + `handlers/config.ts` | `GET/PUT /config/data-agent-instructions` endpoints (Data Agent cookbook editor). If upstream moves the server again, these endpoints move with it. |
| `packages/tui/src/context/route.tsx` | `SettingsTab` includes `"data-sources"` (and legacy `"paper-trading"` mapped to it). |
| `packages/tui/src/routes/settings.tsx` | Data Sources tab (`activeTopTab` mapping, `SettingsPanelDataSources` with `initialSection`). |
| `packages/tui/src/component/settings-panel-data-sources.tsx` | Finny-only file, but lives in the upstream TUI tree — moves when upstream moves the TUI. |
| `packages/app/src/components/dialog-settings.tsx` + `settings-agents.tsx` + `i18n/en.ts` | Agents tab with the Data sources editor (`settings.agents.*` strings). |
| `packages/opencode/src/cli/cmd/tui/` splash/branding (wherever the TUI entry lives) | Finny CLI splash branding (see commit `d2905f1b1`). |
| Root `package.json`, `bunfig.toml` | Workspace catalog: bump via catalog, keep `patches/` (`@standard-community/standard-openapi`, `solid-js`). `test.root` guard stays. |
| `.gitignore` | `.env.*` ignored, `!.env.example` kept. |

### Known renames upstream has already done (rerere won't see these)

- `src/tool/bash.ts` → `src/tool/shell.ts` (tool ID still `"bash"`)
- `packages/opencode/src/cli/cmd/tui/` → `packages/tui/`
- `src/project/instance.ts` (`Instance.directory/worktree/provide`) →
  `InstanceState.context` (`@/effect/instance-state`); tests use
  `provideInstance`/`tmpdirScoped` from `test/fixture/fixture.ts`
- Old Hono instance routes (`src/server/instance/*.ts`) → Effect HttpApi
  (`src/server/routes/instance/httpapi/{groups,handlers}/`)
- Upstream's `plan` agent / plan mode keeps coming back — it is a coding-agent
  mode that bypasses `finnyFileSystemSandbox`, so it is intentionally absent
  from the Finny roster. If the TUI ever shows a fourth "plan" mode after a
  sync, the merge re-introduced it; remove it from `agent.ts` and its tests.

When a conflict shows "deleted in HEAD / modified in theirs" (or vice versa),
check this list first — the right resolution is almost always "port the change
to the new location," not "restore the old file."

## Conflict-resolution rules

1. Identify what each side actually changed:
   `git diff $(git merge-base HEAD upstream/dev) upstream/dev -- <file>` vs
   the same diff for our side. Resolve from intent, not from markers.
2. Upstream structural rewrite + small Finny delta → take upstream's file
   (`git checkout --theirs`/`--ours` as appropriate), then re-apply the Finny
   delta from the ledger.
3. Never re-introduce removed Finny behavior just because upstream still has
   the scaffolding for it (e.g. step budgets, the extract-data tool).
4. After resolving, run the verification gate before pushing.
5. If a ledger invariant no longer fits upstream's architecture, port the
   *behavior* and update the ledger entry in the same PR.
