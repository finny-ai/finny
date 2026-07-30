# Live model and provider harness signal

## Purpose and safety boundary

`Finny harness` runs one weekday live model/provider health signal and supports
the same lane by manual dispatch. It is research evidence only:

- it is not a pull-request merge gate;
- it must not place paper or live orders;
- it must not grant paper approval or mark a strategy production-ready; and
- a successful run proves only that this bounded scenario completed at the
  recorded commit and provider state.

The deterministic fixture jobs remain the merge-gating evidence.

## Ownership and required configuration

The repository administrators who own the model-provider and Alpaca service
accounts own configuration, spend controls, rotation, and incident response.
Configure values in repository Settings only after the owners approve the
specific model and credentials.

Repository variables:

| Name                         | Required value                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `FINNY_LIVE_HARNESS_ENABLED` | Exactly `1` to enable the lane. Remove or set to `0` to disable it.                                     |
| `FINNY_HARNESS_MODEL`        | An intentionally selected `openai/<model>` or `openrouter/<model>` supported by the configured account. |

Repository secrets:

| Provider   | Required secret names                           |
| ---------- | ----------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`                                |
| OpenRouter | `OPENROUTER_API_KEY`                            |
| Alpaca     | `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` |

The legacy Alpaca names `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` are accepted
at the workflow boundary, but new configuration should use the provider-native
names above. Never put credential values in variables, workflow YAML, issues,
pull requests, logs, or artifacts.

The preflight reports names and presence booleans only. Missing configuration
is classified as `configuration_failure` before a model request is made.

## Spend and runtime envelope

Each scheduled run is limited by the committed scenario:

- 20 minutes wall time;
- 40 model turns;
- 50 tool calls;
- 4 subagents;
- 1 algorithm, 1 saved version, and 1 backtest.

There is at most one scheduled run each weekday. Select a model whose
provider-published worst-case pricing fits the service-account budget under
this envelope. The account owner must also configure provider-side spend
alerts and a monthly hard limit; workflow limits are not a substitute for an
account billing cap.

Every evidence manifest records observed turns, tool calls, subagents, tokens,
and estimated model cost when the provider supplies cost metadata. An
unavailable cost is recorded as unavailable, never as zero.

## Activation and verification

1. Confirm issue #34 is merged into `dev`. Until then, the raw scenario and
   source hashes are recorded, but the semantic source/contract fingerprints
   are not reliable comparison keys.
2. Have the service-account owners select the exact supported model and create
   minimum-scope model and Alpaca data credentials. Alpaca credentials are for
   historical market data only; do not grant or exercise order permission.
3. Store the secrets and variables above through repository Settings. Do not
   transmit their values through an issue, PR, or workflow input.
4. Manually dispatch `Finny harness` on `dev`.
5. Confirm `Live signal configuration preflight` is ready and the live job
   publishes `finny-live-headless-<run number>-<attempt>-<run id>`.
6. Download the artifact and verify checksums before reviewing
   `live-signal.json`, the run manifest, and `summary.md`.
7. Confirm the bundle records the expected commit, exact model, scenario hash,
   model and Alpaca provider identities, request adherence, terminal verdict,
   telemetry grade, limits, and observed usage/cost.
8. Leave the schedule enabled only after that complete manual bundle exists.

Activation is not complete if the scheduled job is merely present, preflight
is skipped, or the live job has not produced a complete bundle.

## Evidence retention and comparison

Sanitized preflight and live artifacts are retained for 30 days. Compare the
latest run with recent runs using:

- source commit and raw `scenarioSha256`;
- model and provider identities;
- request-adherence violations;
- terminal verdict and failure classification;
- telemetry grade;
- tool/turn/subagent counts, tokens, and estimated cost; and
- artifact checksums.

Do not upload runtime homes, databases, credentials, or provider responses
outside the bounded evidence artifact. Issue #34 remains the dependency for
trustworthy semantic source and contract hash comparisons.

## Failure classification and response

| Classification                 | First response                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_failure`        | Keep the live run stopped. Verify variable intent, supported model routing, credential presence, and scenario ceilings.             |
| `model_provider_failure`       | Check model-provider health, quota, billing cap, and credential expiry. Do not change harness contract expectations to hide it.     |
| `market_data_provider_failure` | Check Alpaca data entitlement, credential expiry, symbol/feed availability, and provider status. Do not substitute another listing. |
| `harness_contract_failure`     | Compare request adherence, stages, and scenario/source hashes with recent runs. Treat as a harness/model behavior regression.       |
| `evidence_failure`             | Treat the run as unusable. Inspect telemetry grade, checksum/integrity findings, and artifact completeness.                         |
| `timeout`                      | Inspect bounded usage and the last completed stage. Do not raise limits without a reviewed scenario change and spend assessment.    |
| `execution_failure`            | Inspect the sanitized manifest error kinds and raw logs; classify further before retrying.                                          |

Provider flakiness may justify one manual rerun at the same commit, model, and
scenario. Preserve both bundles. Repeated failure is an incident, not a reason
to erase evidence or weaken deterministic checks.

## Rotation, disabling, and incident handling

Rotate a credential through repository Settings, then manually dispatch one
run and verify a complete bundle. Revoke the old credential only after the new
one is verified. Never print either value while rotating.

To stop spend or contain an incident, set `FINNY_LIVE_HARNESS_ENABLED` to `0`
or remove it, cancel any active live workflow run, and revoke affected
credentials at the provider. Preserve sanitized evidence, record the affected
run IDs and time range, and follow
[`docs/security/secret-exposure-response.md`](../security/secret-exposure-response.md)
if exposure is suspected.

Re-enable only after ownership, provider status, credential rotation, spend
controls, and a complete manual-dispatch bundle are verified.
