# Finny secret exposure response

Use this checklist when a model-controlled tool, session artifact, log, or trace may have contained a credential.

## Contain and rotate

1. Stop the affected Finny process and disable the exposed credential at its provider.
2. Rotate every credential or infrastructure token visible in the output. Treat values replayed into later prompts as exposed too.
3. Review `shell.env` plugins and `.env` files that were active for the session. Remove unexpected credential injection before restarting Finny.
4. Confirm the replacement credential has the minimum provider scope needed for the workload.

## Identify affected artifacts

1. Record the Finny session ID, approximate time range, worker name, command, and configured telemetry destination.
2. Search local Finny session storage, logs, truncation artifacts, and direct-run trace files for the old credential value. Do not paste the value into tickets or chat; use a local exact-match search.
3. Search the configured Phoenix, Langfuse, or OpenTelemetry backend over the same time range. Include later model spans because prior tool history may have been replayed.
4. Preserve only the minimum incident evidence required by policy, with credential values redacted.

## Clean up

1. Delete affected local sessions, logs, and truncation artifacts using the normal Finny data-management workflow. Back up only redacted incident metadata before deletion.
2. Delete affected remote traces through the telemetry provider's retention/deletion controls.
3. Verify the old credential no longer authenticates and the replacement credential works only in the intended provider path.
4. Run the worker-shell security regression tests before restoring service.

## Telemetry privacy (operators)

Finny's AI SDK telemetry records structured span metadata and token accounting.
Raw prompt and completion recording is **disabled** (`recordInputs` /
`recordOutputs` false via `aiSdkTelemetryPrivacy`).

| Env | Required for debug content? | Rules |
|-----|----------------------------|--------|
| `FINNY_OTEL_CAPTURE_PAYLOADS` | Yes | Must be exactly `1` |
| `FINNY_OTEL_PAYLOAD_RETENTION_HOURS` | Yes when capture is on | Integer **1–24**; missing/out-of-range disables capture |
| `FINNY_OTEL_PAYLOAD_MAX_BYTES` | No | Optional lower cap; **cannot** exceed 32 KiB |

Debug content must go through `sanitizeTelemetryPayload` only (hashes + sizes by
default; redacted content when policy is enabled). The telemetry backend must
enforce the same or shorter retention window reported on each sanitized payload.

Issue #134 (and any future span work) must consume this exported contract — do
not re-enable AI SDK raw payload capture in `agent.ts` / `session/llm.ts`.

## Worker allowlist maintenance

See `docs/security/worker-env-allowlist.md`. Run
`bun test test/security/worker-shell.test.ts` after changing
`DATA_PROVIDER_CREDENTIALS` or runtime allowlists.
