# Claude AI Agent System Prompt / Guidelines

You are Claude, operating within the **Finny** monorepo workspace. Your primary objective is to assist the user by writing clean, performant, and correctly structured code following the project's established conventions and core product vision.

## ⚠️ Fork Relationship — READ FIRST

Finny is a **fork of [OpenCode](https://github.com/anomalyco/opencode)**. We periodically rebase our `dev` branch onto upstream `anomalyco/opencode:dev`. This means:

- **Minimize changes to upstream files.** Every modified upstream file is a potential rebase conflict. Prefer adding new files alongside existing ones over editing upstream files.
- **The `.agents/` directory, `packages/finny-*` directories, and Finny-specific prompt files (`finny-*.txt`) are fork-only.** These don't exist upstream and are safe to modify freely.
- **Only ~7 upstream files are intentionally modified** for branding (see `SYNC_FORK.md`). Do not modify additional upstream files without good reason.
- **Keep upstream conventions.** The config dir is still `.opencode/`, env vars are still `OPENCODE_*`, and the core package lives at `packages/opencode/`. This is intentional to reduce rebase friction.
- See `.agents/SYNC_FORK.md` for the full sync workflow.

## 🎯 Core Product Vision

Finny is an AI-powered CLI for financial markets, built on top of the OpenCode TUI framework. It uses a BYOK (bring your own key) model — users provide their own AI API keys. It features 3 agent modes: **Build** (immediate algo generation), **Research** (asks clarifying questions first), and **Chat** (conversational).

## Project Context

You are working in a **Bun + Turbo** monorepo forked from OpenCode. The TUI is built with Solid.js + @opentui/solid.

**Key Packages (upstream, inherited from OpenCode):**
- `packages/opencode`: Core CLI, TUI, agents, and session logic
- `packages/web`: Documentation site (Astro)
- `packages/desktop`: Tauri desktop app

**Key Packages (fork-only, Finny additions):**
- `packages/finny-core`: Finny core utilities
- `packages/finny-registry`: Strategy/algorithm registry
- `packages/finny-integrations`: External service integrations

## Mandatory Behavior Rules 🚨

1. **Tool Usage**:
   - Utilize parallel tool execution whenever possible.
   - Use specialized filesystem tools (`list_dir`, `view_file`, `write_to_file`, `grep_search`) rather than bash equivalents (`ls`, `cat`, `grep`).
   - For web automation, strictly use the `agent-browser` CLI workflow (open -> snapshot -> interact -> snapshot).

2. **Package Management & Scripts**:
   - **Always use `bun`**. Never use `npm`, `yarn`, or `pnpm` unless explicitly targeting a sub-module that requires it.
   - Use `bun turbo <command>` for global workspace commands.

3. **Frontend Implementation (SolidJS)**:
   - Stick to SolidJS paradigms. Use `createSignal`, `createEffect`, and strictly prefer `createStore` for objects or arrays.
   - Do NOT write React code (e.g., `useState`, `useEffect`).
   - Use TailwindCSS for styling.

4. **Backend Implementation (Cloudflare/SST/Hono)**:
   - API endpoints are primarily handled as Cloudflare workers (often routed via Hono). Do not write Node.js specific code that depends on `fs` or `path` in Worker contexts unless using Node compat layers where permitted.

5. **Database Changes (Convex)**:
   - Schema modifications MUST be done in `convex/schema.ts`. We have migrated off Drizzle. Do NOT use Drizzle or write `*.sql.ts` files.
   - Core tables include `projects`, `sessions`, `messages`, `workspaces`, and `controlAccounts`. Domain-specific tables include `algoclashUsers`, `algoclashAlgorithms`, `algoclashTrades`, `algoclashPortfolios`, and `algoclashLeaderboard`.
   - Table names and fields generally use `camelCase` or plural lowercase.
   - Changes are synced directly via `bunx convex dev` instead of generating migrations.

6. **Safety & Stability**:
   - Do not restart development servers independently.
   - For UI changes in the `app` package locally, verify them at `http://localhost:4444` connected to backend `http://localhost:4096`. 

## Output Formatting

- Deliver concise, highly targeted code edits.
- Ensure all markdown responses are clearly formatted.
- Avoid modifying code outside of the requested scope unless resolving a cascading type/lint error.
