# Deterministic headless scenario matrix

The merge-gating matrix is deliberately small. Scenario files are canonical,
versioned contracts; evidence fixtures are deterministic observations rather
than live provider claims. The matrix command writes one bounded JSON artifact
per scenario plus `index.json`, which records expected and actual terminal
classification, scenario/evidence hashes, telemetry grade, typed violations,
and any declared dependency.

## Covered contracts

| Scenario                           | Contract boundary                                        | Promotion boundary                    |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `spy-5m-sma-crossover.v1`          | Existing real-CLI SPY/XNYS negative workflow             | Backtested, never qualified           |
| `strict-positive-qualification.v1` | Reserved promotion-stage contract                        | Blocked on #44, which depends on #34  |
| `btc-usd-24x7.v1`                  | BTC/USD on Coinbase, UTC, and a 24/7 calendar            | Identity proof only                   |
| `spy-qqq-complete-evidence.v1`     | One verified identity per SPY and QQQ                    | Missing either symbol fails closed    |
| `shop-tsx-exact-listing.v1`        | `SHOP.TO` / `SHOP@XTSE`, `XTSE`, Toronto time            | No US ticker or calendar proxy        |
| `spy-provider-degraded.v1`         | Incomplete, degraded, unresolved, unknown-basis evidence | Research-only; promotion is forbidden |

Every row declares its required stages, allowed recoveries, exact instrument
identity, expected terminal classification, evidence policy, and whether
promotion is legally possible. `research_only` is a valid expected matrix
outcome; a typed contract violation is a harness failure.

Run the bounded contract partitions with:

```sh
bun run --cwd packages/opencode harness:matrix -- --partition identity --output ../../.artifacts/headless-matrix-identity
bun run --cwd packages/opencode harness:matrix -- --partition degradation --output ../../.artifacts/headless-matrix-degradation
```

The workflow partition continues to run the existing full isolated scripted
SPY CLI fixture. The strict-positive workflow is not simulated: it remains
`dependency_blocked` until #44 provides the runtime-owned experiment,
holdout-approval, qualification, and final review-packet path. The published
harness source/contract semantic hashes also remain dependent on #34.

## Outside this harness

Live-model repetitions belong to #45 and are not merge-gating matrix evidence.
The fixtures do not prove live alpha, provider availability, brokerage support,
paper/live permission, or profitability. They also do not exhaust every
exchange, corporate action, price basis, provider failure, interval, or
strategy family.
