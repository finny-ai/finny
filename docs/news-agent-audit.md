# News Agent Audit and Implementation Plan

Date: 2026-06-16

## Current Conversion

The current strategy-validation research subagent has been converted into `news_agent` as the preferred runtime agent:

- `build`, `research`, and `chat` now delegate current context work with `task(subagent_type="news_agent")`.
- `researcher` remains as a hidden compatibility alias so old sessions/configs do not break.
- `news_agent` uses the new `finny-news-agent.txt` prompt and `.opencode/agent/news_agent.md` override.
- The workspace context injector and read/write/edit guards accept both `news_agent` and the old `researcher` alias.

## Runtime Flow

1. A primary agent receives a user request.
2. `FinnyWorkspacePlugin` bootstraps a session workspace for `build` and `research` prompts when request facts include a symbol.
3. The parent calls `task` with `subagent_type="news_agent"`.
4. `TaskTool` resolves or creates a child session, inherits the parent workspace binding, and injects `<finny-subagent-context>`.
5. The injected context gives `news_agent`:
   - `workspace_slug`
   - `workspace_name`
   - `requested_algorithm_name`
   - `requested_symbol`
   - `requested_interval`
   - `requested_asset_class`
   - `workspace_news_dir`
6. `news_agent` searches/fetches current context and may read configured Discord channels.
7. It writes at most one compact note under `workspace_news_dir/body/` unless the parent explicitly sets `explicit_news_scan: true`.
8. The final task result is injected back into the parent as text.
9. Build must verify identity metadata and use only matching, usable evidence before save/validate/backtest.

## Inputs

Parent prompt requirements:

- Concrete symbol or market focus.
- Interval and asset class when known.
- Date range or a clear duration. If missing, `news_agent` defaults to the last 14 days.
- Strategy intent and requested algorithm name when known.
- Explicit source/channel scope if the user wants broad macro, FOMC, CPI/jobs, geopolitical, oil, or general-news scanning.

Runtime-injected inputs:

- Workspace path via `workspace_news_dir`.
- Parsed request identity from `parseRequestFacts`, `extractDateWindow`, and `syncWorkspaceRequestContext`.
- Existing mission/request context when the session already has it.

## Tool Surface

`news_agent` currently exposes:

- `webfetch`
- `websearch`
- `finny_discord_read`
- `read`
- `write`
- `edit`
- `apply_patch`

Risk: `apply_patch` is visible because it is not denied by the Finny filesystem sandbox or narrow news-agent bundle. The prompt says to use `write`, not `apply_patch`, but permissions should enforce this.

## Outputs to Parent

The final response contract is:

- `## News Agent Brief: {topic}`
- Sources checked
- Files written
- Time window
- Identity
- Relevance
- Current News / Catalysts
- Execution / Market Microstructure
- Data Provenance / Reproducibility
- Risk Regime
- Strategy Implications
- Gaps / Caveats

Hard requirements:

- No buy/sell labels.
- No invented citations.
- No promotional language.
- Artifact paths must be under `workspace_news_dir/body/` unless explicit headline scanning was requested.

## Durable Artifacts Found

Repo-local files:

- `algos/_template/data/news/body/.gitkeep`
- `algos/_template/data/news/headlines/.gitkeep`
- `packages/opencode/data/news/btc-q1-2024-macro-context.md`

Local Finny store scan under `~/.local/share/finny/algos`:

- 307 total `data/news` files.
- 109 files under `headlines/`.
- 185 files under `body/`.
- 13 flat legacy files directly under `data/news/`.
- 45 algorithm/workspace directories with news artifacts.

Observed artifact problems:

- Legacy flat files exist directly under `data/news/`, outside the current `body/` and `headlines/` convention.
- Some old outputs use `RESEARCH-SUMMARY.md` / `RESEARCH_SUMMARY.md` naming.
- At least one stored path includes a literal `*` in the algorithm directory name: `spy-momentum-1h.*`.
- Several old artifacts are broad macro/headline rolls, which conflicts with the current default of compact, directly relevant context unless explicit broad scan is requested.

## Issues

1. Naming is still split.
   - Preferred path is now `news_agent`, but old source/test names still use `researcher` for compatibility guard coverage.
   - `packages/opencode/src/agent/prompt/finny-researcher.txt` remains stale and unused by the registry.

2. Primary `research` mode is still visible.
   - Current tests expect visible Build, Research, and Chat.
   - Prior product direction said Research should be compatibility-only/hidden after merging behavior into Build.
   - This needs an explicit product decision because changing it affects TUI mode ordering and tests.

3. `news_agent` can still see `apply_patch`.
   - The audit output reports `apply_patch` as visible for `news_agent`.
   - This is inconsistent with a subagent that should only write controlled markdown notes.

4. Build prompt mentions denied tools.
   - `finny-audit.ts` reports denied-tool mentions in Build: `apply_patch`, `bash`, `edit`, `finny_get_history`, `invalid`, `list_tasks`, `task_status`, `write`.
   - Some are intentional negative rules, but the audit cannot distinguish forbidden mentions from accidental instructions.

5. `news_agent` final output is not machine-validated.
   - Data Extractor has `validateDataExtractorTaskText`.
   - News Agent only relies on prompt compliance and parent prompt checks.
   - Missing identity, mismatched artifacts, or unstructured output can still leak through unless Build catches it.

6. Stale docs describe a removed workflow.
   - `docs/researcher-workflow.md` still talks about `finny_research_dispatch`, background researcher dispatch, and broad headline/body writing.
   - Current code delegates through `task(subagent_type="news_agent")` and no longer has that dispatch tool path.

7. Artifact migration is unresolved.
   - Existing old files are not normalized.
   - Current code avoids new flat files, but old local store artifacts remain mixed.

## Implementation Plan

Phase 1: Finish the rename safely.

- Keep `researcher` as a hidden alias for one release.
- Rename `finny-researcher.test.ts` to `finny-news-agent.test.ts`.
- Rename `assertResearcherWorkspaceNewsPath` to `assertNewsAgentWorkspaceNewsPath` and export a compatibility alias only if needed.
- Replace stale references in docs and comments.
- Either delete `finny-researcher.txt` or turn it into a one-line compatibility shim copied from `finny-news-agent.txt`.

Phase 2: Tighten permissions.

- Explicitly deny `apply_patch` for `news_agent`.
- Consider denying `edit` too and forcing only `write` for new notes, unless edit is needed for controlled note updates.
- Add tests proving `news_agent` cannot write outside `workspace_news_dir/body/` and cannot use `apply_patch`.

Phase 3: Validate News Agent outputs.

- Add `validateNewsAgentTaskText`, similar to Data Extractor validation.
- Require:
  - `News Agent Brief`
  - `Identity:` with requested symbol, interval, asset class, algorithm name, artifact paths
  - `Files written:` paths under `workspace_news_dir/body/` or `none`
  - no artifact paths outside the bound workspace
  - explicit `no material current context found` when there is no useful evidence
- Wire this validator into `TaskTool` for `subagent_type === "news_agent"` and compatibility `researcher`.

Phase 4: Normalize artifact storage.

- Add a read-only scanner for local `data/news` artifacts that reports:
  - flat files
  - headline rolls
  - body notes without identity metadata
  - paths with suspicious characters like literal `*`
- Add an explicit migration command or script only after review.
- Migration target:
  - flat note files -> `data/news/body/`
  - summary files -> `data/news/body/<slug>-summary.md`
  - preserve original file in a manifest or migration log.

Phase 5: Decide Research primary mode.

- If Research should be hidden:
  - set `research.hidden = true`
  - remove it from visible primary mode tests and ordering
  - keep config/default-agent compatibility error coverage
  - update TUI docs and mode copy
- If Research remains visible:
  - update memory/docs to stop claiming it is compatibility-only
  - make Research delegate to `news_agent`, not `researcher`, everywhere.

Phase 6: Replace stale workflow docs.

- Rewrite `docs/researcher-workflow.md` around `news_agent`.
- Remove `finny_research_dispatch` references.
- Show foreground Build mandatory flow and optional Chat/Research current-news flow separately.
- Document that broad headline rolls require `explicit_news_scan: true`.

## Verification Run

Passed:

```bash
cd /Users/jaiminpatel/github/finny-folder/finny-internal-prop/packages/opencode
PATH=/Users/jaiminpatel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  bun test test/agent/finny-researcher.test.ts test/tool/task.test.ts test/agent/agent.test.ts test/agent/finny-debloat.test.ts
```

Result: 94 pass, 0 fail.

Passed:

```bash
cd /Users/jaiminpatel/github/finny-folder/finny-internal-prop/packages/opencode
PATH=/Users/jaiminpatel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  bun script/finny-audit.ts
```

Result: audit JSON emitted successfully and process exited with code 0.
