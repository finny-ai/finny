---
schema_version: 1
name: REPLACE-ME-kebab-case
status: research
created: YYYY-MM-DD
hypothesis: |
  One paragraph stating the market inefficiency this algo intends to capture
  and the mechanism it uses. Treat this as the single sentence you would say
  to a colleague who asked "what is this trying to do?".
scope:
  asset_class: equities       # equities | crypto | futures | fx | options | mixed
  universe: [SYM1, SYM2]
  horizon: days               # intraday | days | weeks | months
exit_conditions: |
  - Time stop: ...
  - Price stop: ...
  - Thesis stop: ...
---

# REPLACE-ME

Rationale, sources, links, anything that helps a future reader or agent
understand *why* this algorithm exists. The frontmatter above is the
machine-read contract; this body is for humans and LLMs reading the folder
cold.
