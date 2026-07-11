# Worker shell environment allowlist

Finny workers (`data_extractor`, `news_agent`, `sec_agent`, `sentiment_agent`,
`researcher` / `research`) run model-controlled bash with a **deny-by-default**
environment. Only keys registered in
`packages/opencode/src/security/worker-shell.ts` can appear in the child process.

Policy version: `WORKER_SHELL_POLICY_VERSION` (exported from that module).

## What workers receive

| Agent | Environment |
|-------|-------------|
| news / SEC / sentiment / research | Runtime only (`PATH`, `HOME`, workspace/python paths, CA bundles, harness fixture keys, …) |
| `data_extractor` | Runtime + **asset-scoped market-data credentials** from `request.json` |

Runtime also includes non-secret headless harness plumbing (`FINNY_HARNESS_MODE`,
`FINNY_HARNESS_MARKET_DATA_URL`, CSV/sha256 fixture markers). These are required
for Data Agent fixture materialization; they are **not** a blanket `FINNY_*`
allowlist (`FINNY_TELEMETRY_SECRET` stays denied).

LLM provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …), plugin secrets, and
telemetry secrets are **never** allowlisted for workers.

## Data Agent credential scope

| Asset class (`requested_asset_class`) | Credential keys |
|--------------------------------------|-----------------|
| equity / stock / etf (aliases) | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_DATA_FEED`, `POLYGON_API_KEY`, `MARKET_DATA_API_KEY`, `BLOOMBERG_API_KEY`, `ORACLE_MARKET_DATA_URL`, plus public `BINANCE_BASE_URL` |
| crypto (aliases) | `BINANCE_BASE_URL` only (public market data) |
| missing / unknown | Runtime + `BINANCE_BASE_URL` (keyless fallback) |

Source of truth: `DATA_PROVIDER_CREDENTIALS` in `worker-shell.ts`.

## Adding a new market-data credential

1. Add a row to `DATA_PROVIDER_CREDENTIALS` with the env key and asset class(es).
2. Teach the engine/provider (or shell preflight injector) to read that key.
3. Extend `packages/opencode/test/security/worker-shell.test.ts` for the asset.
4. Update this doc’s table.
5. **Do not** allowlist host LLM keys, broker *trading* secrets for live, or
   telemetry secrets for workers.

## Related

- Incident response: `docs/security/secret-exposure-response.md`
- Telemetry privacy: `@/security/telemetry` (`aiSdkTelemetryPrivacy`,
  `sanitizeTelemetryPayload`, `TELEMETRY_PAYLOAD_ENV`)
