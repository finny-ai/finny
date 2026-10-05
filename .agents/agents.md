# Finny contributor guide

Read the root AGENTS.md and the guidance under each package you change.
The current architecture and package map live in README.md; cleanup boundaries
and verification commands live in docs/harness-cleanup.md.

- Finny is the trading-research CLI and HTTP harness in packages/opencode.
- packages/core owns local sessions, SQLite schemas, and migrations; preserve
  those alongside the remaining Convex subscription and telemetry boundaries.
- packages/tui and the embedded packages/app client consume the harness. Shared
  provider, SDK, plugin, and UI packages are active build dependencies.
- packages/finny-core owns strategy workspaces, documents, and preferences.
- Use Bun and package-scoped tests. Root bun test intentionally fails.
- Preserve data provenance, strict validation, experiment lineage, review gates,
  and explicit human approval. A recommendation cannot authorize execution.
- Preserve unrelated edits and running services; use isolated verification.
- Follow UPSTREAM_SYNC.md when merging upstream. Retired hosted products and
  deployment stacks must stay outside this harness workspace.
