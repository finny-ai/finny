# Social Sentiment Agent Spec

Date: 2026-06-29
Status: proposed

## Decision

Add a standalone `sentiment_agent` subagent. Do not fold this into `news_agent`.

Persist aggregate sentiment artifacts and manifest sidecars only. Treat raw social
posts/comments as transient evidence used during scoring, not as durable product
artifacts and not as parent-context payload. This keeps the parent context small and
reduces commercial-license exposure for a paid `finny-pro` workflow.

## Purpose

`sentiment_agent` is a bash-first subagent for crowd-positioning evidence. The
parent calls it when a strategy needs social sentiment, attention, or positioning
context for a symbol and time window.

The agent fetches free or keyless social sources, scores or aggregates the evidence,
writes bounded artifacts under the active algorithm's `data/sentiment/` tree, and
returns a compact brief to the parent. It must never return buy/sell labels or claim
that sentiment proves an edge.

## Runtime Flow

1. A primary agent receives a request that needs social sentiment evidence.
2. The parent calls `task` with `subagent_type="sentiment_agent"`.
3. `TaskTool` resolves or creates a child session and injects
   `<finny-subagent-context>`.
4. The injected context gives `sentiment_agent`:
   - `workspace_slug`
   - `workspace_name`
   - `requested_algorithm_name`
   - `requested_symbol`
   - `requested_interval`
   - `requested_asset_class`
   - `allowed_sentiment_dir`
   - requested start/end dates or a default lookback
5. `sentiment_agent` selects sources by asset class and window.
6. It fetches with `bash` and Python stdlib where practical, following the
   `data-agent/instructions.md` no-install pattern.
7. It writes a CSV plus `.manifest.json` sidecar under `allowed_sentiment_dir`.
8. It returns `## Sentiment Agent Brief: {topic}` with source attempts, written
   paths, identity, coverage, aggregate signals, and caveats.
9. The parent uses the brief and artifact paths as evidence. The parent does not
   receive raw posts, raw comments, or large text dumps.

## Source Selection

Use the explicit source from the task when supplied. Otherwise:

1. Equities/ETFs:
   - StockTwits public symbol stream for live message-level polarity.
   - ApeWisdom for Reddit attention/buzz when available.
   - Arctic Shift or PullPush for historical Reddit text when a historical window
     is requested.
2. Crypto:
   - StockTwits public symbol stream when the symbol is supported.
   - ApeWisdom crypto filters for attention/buzz when available.
   - Bluesky only when explicitly requested or when a reliable query path is added.
3. Broad macro, issuer, or event context belongs to `news_agent`, not
   `sentiment_agent`, unless the prompt explicitly asks for crowd reaction to that
   event.

Every attempted host must be recorded in `source_attempts`, including failures,
empty responses, rate limits, and coverage limits.

## Free Source Recipes

### StockTwits

Use:

```bash
curl -fsS --max-time 20 \
  -H "User-Agent: Mozilla/5.0" \
  "https://api.stocktwits.com/api/2/streams/symbol/${SYMBOL}.json"
```

Extract:

- message timestamp
- message id
- source symbol
- user-provided sentiment label when present (`Bullish`, `Bearish`)
- sanitized text only in memory

Do not persist message body text in v1. Persist counts and derived aggregate ratios.

### ApeWisdom

Use its public JSON endpoints as an attention source, not a polarity source. Persist
rank, mentions, upvotes, previous rank, previous mentions, and computed rank/mention
changes when the requested symbol appears.

### Arctic Shift / PullPush

Use only for historical Reddit windows. Fetch bounded samples for requested symbol
queries, score in memory, and persist aggregate counts by date/source. Record query
limits and actual coverage in the manifest.

### Bluesky

Treat as a later source unless the implementation adds a reliable query/firehose
adapter. It is useful as a free X-like network, but current Finny v1 should not block
on it.

## Scoring

Use a cheapest-first scoring path:

1. Use StockTwits user labels directly where present.
2. Score unlabelled social text with the available parent LLM only when the text
   volume is small and directly relevant.
3. Add FinBERT later only if it is already available in `$FINNY_PYTHON_BIN` or
   `$FINNY_MANAGED_PYTHON`. Do not `pip install` during a subagent run.

Normalize output to:

- `bullish_count`
- `bearish_count`
- `neutral_count`
- `unscored_count`
- `bull_ratio`
- `bear_ratio`
- `net_sentiment`
- `mention_count`
- `attention_delta`
- `n_messages`

`net_sentiment` should be `(bullish_count - bearish_count) / scored_count` when
`scored_count > 0`; otherwise leave it blank or `not_available`.

## Artifact Contract

Write under:

```text
<allowed_sentiment_dir>/
  body/
    <symbol>_<window>_sentiment.csv
    <symbol>_<window>_sentiment.manifest.json
```

CSV columns:

```text
date,symbol,source,bullish_count,bearish_count,neutral_count,unscored_count,bull_ratio,bear_ratio,net_sentiment,mention_count,attention_delta,n_messages
```

Manifest fields:

```json
{
  "schema_version": 1,
  "source": "stocktwits+apewisdom",
  "symbols": ["AAPL"],
  "requested_symbol": "AAPL",
  "actual_symbol": "AAPL",
  "requested_interval": "1d",
  "actual_interval": "1d",
  "requested_asset_class": "equity",
  "actual_asset_class": "equity",
  "requested_algorithm_name": "aapl-sentiment-breakout",
  "requested_start": "2026-06-01",
  "requested_end": "2026-06-29",
  "actual_start": "2026-06-28",
  "actual_end": "2026-06-29",
  "output_path": "body/AAPL_2026-06-01_2026-06-29_sentiment.csv",
  "rows": 2,
  "run_id": "20260629T141500Z-aapl-sentiment",
  "coverage": "partial",
  "coverage_note": "StockTwits public stream returned recent messages only",
  "usable_for_parent": "yes",
  "source_attempts": [
    {"source": "stocktwits", "status": "ok", "rows": 30},
    {"source": "apewisdom", "status": "ok", "rows": 1}
  ],
  "raw_text_persisted": false,
  "created_at": "2026-06-29T14:15:00Z"
}
```

Do not store command text, credential names, secret values, raw post bodies, raw
comment bodies, author handles, or direct profile URLs in manifests.

## Output to Parent

The final response contract is:

```markdown
## Sentiment Agent Brief: {topic}
- Sources checked: {URLs/hosts checked}
- Files written: {paths under allowed_sentiment_dir/body/, or none}
- Time window: {requested and actual coverage}
- Identity: requested_symbol={...}; requested_interval={...}; requested_asset_class={...}; requested_algorithm_name={...}; artifact_paths={...}
- Coverage: {full|partial|empty} - {short reason}

### Aggregate Signal
- {bull/bear/neutral counts, ratios, attention change, and n}

### Source Attempts
- {source}: {ok|empty|failed|rate_limited} - {concise detail}

### Strategy Implications
- {validation constraints, regime caveats, sizing/fill concerns, or why the signal is too thin}

### Gaps / Caveats
- {source limits, missing history, scoring ambiguity, license caveat, or no material social evidence}
```

Hard requirements:

- No buy/sell labels.
- No invented citations.
- No raw social post dumps.
- No promotional language.
- Artifact paths must be under `allowed_sentiment_dir/body/`.
- If no useful evidence is found, say `no material social sentiment found`.

## Implementation Touch Points

Mirror the `news_agent` and `data_extractor` patterns:

- `packages/opencode/src/storage/local/algorithm-store.ts`
  - add `data/sentiment/body/.gitkeep` handling for algorithm scaffolds.
- `packages/opencode/src/agent/agent.ts`
  - register `sentiment_agent`.
  - add workspace path helpers equivalent to the news/sec access helpers.
  - expose a narrow bundle with `bash`, `webfetch`, and `websearch` only if needed.
- `packages/opencode/src/tool/task.ts`
  - add a `sentiment_agent` branch that injects `allowed_sentiment_dir`.
- `packages/opencode/src/tool/shell.ts`
  - guard bash writes so `sentiment_agent` can write only under `data/sentiment/`.
- `packages/opencode/src/agent/prompt/finny-sentiment-agent.txt`
  - add the durable prompt and output contract.
- `.opencode/agent/sentiment_agent.md`
  - add the local override with hidden subagent mode and denied-by-default tools.

## Validation Plan

Add focused tests before enabling the agent in primary bundles:

1. Agent registry includes `sentiment_agent` and keeps it hidden.
2. `task(subagent_type="sentiment_agent")` injects the requested identity and
   `allowed_sentiment_dir`.
3. Shell guard denies writes outside `data/sentiment/`.
4. Output validator accepts the required `Sentiment Agent Brief` shape and rejects
   raw social dumps or artifact paths outside the bound workspace.
5. A fixture manifest with partial StockTwits coverage is accepted when
   `usable_for_parent` is `yes` and coverage notes explain the limit.

Manual smoke after implementation:

```bash
cd packages/opencode
PATH=/Users/jaiminpatel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  bun test test/agent/agent.test.ts test/tool/task.test.ts
```

Then run one TUI/headless flow that asks for sentiment on a liquid ticker and verify
the child session writes only aggregate CSV/manifest files under `data/sentiment/`.

## Accepted V1 Policy

- `data/sentiment/headlines/` must not exist in v1. `sentiment_agent` writes only
  aggregate artifacts under `data/sentiment/body/`.
- Raw social text persistence is not allowed, even with explicit local-only user
  opt-in. The agent may inspect bounded raw text transiently during a run, but
  durable artifacts must contain aggregates, coverage metadata, source attempts,
  and caveats only.
- Social sentiment is not mandatory for every build validation. The main agent
  decides whether to call `sentiment_agent` when the strategy, symbol, market
  regime, or user request would benefit from crowd-positioning evidence.
