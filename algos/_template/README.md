# Algo template

This directory is the canonical layout every Finny algorithm uses. Copy it
verbatim when creating a new algo, then fill in `mission.md`, replace the
strategy stub, and grow the rest of the folder as the algo matures.

```
<algo-name>/
  mission.md          # Stable contract — what this algo is, why it exists.
  decisions.md        # Append-only log of design decisions and rejections.
  prefs.md            # Per-algo taste (sizing, risk, constraints).
  CURRENT             # Single line naming the active version folder (e.g. "v1").
  v1/
    strategy.py       # Executable strategy.
    backtest.json     # Produced by the backtest runner (absent until first run).
    notes.md          # Why this version exists, what changed, disposition.
  .archive/           # Raw chat transcripts, one per day touched. Created on first need.
```

## Conventions

- Folder name is kebab-case (`hanta-biotech-swing`) and must match
  `mission.frontmatter.name`.
- `mission.md` has YAML frontmatter governed by `schema_version: 1`. The
  schemas live in `@finny-ai/core/algo`.
- `CURRENT` contains exactly one token, the version directory name. No JSON,
  no YAML, no comments.
- Versions mark **structural intent change**, not promotion events. Tuning
  parameters is an in-place edit; ripping out the stop-loss is a new `vN+1`.
- `backtest.json` is not created until a backtest runs. All eight metric
  fields are required (`null` is acceptable for genuinely unmeasurable).
- `.archive/` chat transcripts are never deleted. Compaction (a future
  agent) produces a derived view in `decisions.md`; the source stays here.

## Where algos live

User-owned algorithms live under
`${XDG_DATA_HOME:-$HOME/.local/share}/finny/algos/` (or
`%LOCALAPPDATA%\finny\algos\` on Windows). Only this template ships in the
repo.
