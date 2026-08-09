# Synthetic positive qualification harness

The `positive_qualification` headless fixture proves that Finny can carry one
deterministic request through the real CLI, strict-qualified DatasetEvidence,
an immutable ExperimentPlan and QualificationPolicy, the structured sealed
holdout approval, runtime-owned exploratory/validation/confirmatory phases, an
authoritative `recommended_for_paper` WorkflowRun, and one final hash-bound
review packet.

This is synthetic harness proof only. Its generated prices and result are not
market evidence, evidence of live alpha, or permission to start paper or live
trading. The fixture never calls `finny_paper_approve`; paper approval remains
a separate human-controlled boundary.

Run it with a Phoenix collector available:

```sh
FINNY_HARNESS_E2E=1 \
FINNY_HARNESS_E2E_GROUP=positive \
FINNY_HARNESS_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 \
bun --cwd packages/opencode test test/harness/headless-fixture-e2e.test.ts
```

The scenario requires these promotion stages:

- `experiment_planned`
- `holdout_approved`
- `qualified`
- `review_packet_ready`

The approval responder is active only when harness mode, the scripted model,
the positive fixture, and the scenario's sealed-holdout authorization all
agree. It answers only the exact one-question plan/hash/policy structure and
fails closed for altered headers, scope fields, option order, or multiplicity.

GitHub Actions uploads the bounded positive evidence bundle even when the
fixture fails. Review `run-manifest.json`, `checksums.sha256`, the copied
qualification artifacts, and the single final `review.html` together; no one
artifact alone establishes the contract.
