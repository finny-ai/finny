### Issue for this PR

Closes #

### Type of change

- [ ] Bug fix
- [x] New feature
- [ ] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

First-launch onboarding v2 for the TUI:

1. **Email (required)** — shown once on first launch; cannot skip during onboarding (`allowSkip: false`). `/subscribe` remains a separate, skippable path for later.
2. **Choose path** — trader vs beginner cards with distinct welcome prompts.
3. **Welcome session** — routes home with `initialPrompt` + auto-submit on a free OpenCode model (no dedicated providers onboarding step; users can configure providers via the existing Provider capsule).

Runs **once per install**, gated by KV `onboarding_v2_status` (legacy `experience_level_status` still skips repeat runs).

**Removed / not included**

- Providers onboarding dialog
- In-app KV reset (`/reset-kv`, `kv.reset()`, etc.)

**Other changes in branch**

- Sidebar: Sessions moved up
- Session: thinking default `false`
- `finny-chat.txt`: FIRST IMPRESSIONS section for welcome copy
- Onboarding prompt unit tests

### How did you verify your code works?

```bash
git checkout feat/onboarding-v2
bun install
cd packages/opencode && bun run dev
bun test test/cli/tui/onboarding-prompts.test.ts
bun run typecheck
```

**Reset first-launch state for manual QA** (no slash command):

```bash
# Default path (XDG state dir + finny/kv.json). Override with XDG_STATE_HOME if set.
rm -f "${XDG_STATE_HOME:-$HOME/.local/state}/finny/kv.json"
```

Then **fully quit and restart** the TUI (`finny` or `bun run dev` from `packages/opencode`). Deleting the file while the app is running does nothing until restart.

If you never see onboarding after that, check you are not grandfathered (`onboarding_v2_status` / `experience_level_status` already set) — inspect the file or delete the whole `finny` state dir under the same parent path.

### Screenshots / recordings

_If this is a UI change, please include a screenshot or recording._

### Checklist

- [x] I have tested my changes locally
- [x] I have not included unrelated changes in this PR
