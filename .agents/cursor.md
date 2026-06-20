# Cursor AI Agent Guide — Finny

You are operating in the **Finny** monorepo. Finny is a fork of [OpenCode](https://github.com/anomalyco/opencode) — an AI-powered CLI/TUI for financial markets.

See `.agents/agents.md` and `.agents/claude.md` for repo-wide conventions. This file adds Cursor-specific guidance for the **Data Agent** and its **bash** tool.

## Data Agent overview

The Data Agent (`data_extractor`) fetches market data via host `bash` recipes defined in `data-agent/instructions.md`. It does not write strategies or run backtests.

Key behaviors enforced in `packages/opencode/src/tool/bash.ts`:

- **Default cwd**: session-bound algorithm `data/` directory (`ALLOWED_DATA_DIR` / `FINNY_ALLOWED_DATA_DIR`).
- **Write guard**: redirects and mutating commands (`mkdir`, `cp`, `mv`, `rm`, `tee`, etc.) must target the session workspace `data/` subtree only.
- **Read guard**: `cat`, `head`, `tail`, `wc`, `ls` on paths outside the session `data/` root are blocked. Repo cookbooks must be read with the `read` tool, not bash.
- **Env isolation**: `.env` values are injected into bash env internally; the model must not read `.env` or `.env.*` via bash or the read tool.
- **Session binding**: workspace slug comes from `bindSessionWorkspace(sessionID, slug)` in `@finny-ai/core/algo`.

## Testing the bash Data Agent CLI

Run from `packages/opencode`:

```bash
bun test test/tool/bash.test.ts
bun test test/tool/read.test.ts test/tool/read-path.test.ts test/tool/task.test.ts
```

Focus on the `tool.bash data_extractor write guard` describe block — it covers env loading, path guards, manifest writes, and non-data-agent isolation.

## TUI manual checks

1. Start backend: `bun run --conditions=browser ./src/index.ts serve --port 4096` (from `packages/opencode`).
2. Open the TUI or app connected to that backend.
3. Select the **Data Agent** (or invoke via Build/Research task delegation).
4. Ensure a session workspace is bound to an algorithm with a `data/` directory.
5. Confirm bash writes land under that algo's `data/` tree and that blocked reads/writes show clear guard errors.

## Fork safety

- Prefer adding fork-only files (`.agents/`, `data-agent/`, `packages/finny-*`) over editing upstream OpenCode files.
- Do not restart dev servers unless explicitly asked.
