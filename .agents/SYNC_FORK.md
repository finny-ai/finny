# Sync Fork with Upstream

## How it works

We rebase our `dev` branch onto upstream `anomalyco/opencode:dev`. This replays our Finny-specific commits **on top of** the latest upstream code, keeping a clean linear history:

```
(top)    Your Finny commits      <-- newest, your work
         ...
(bottom) Upstream OpenCode commits <-- oldest, from anomalyco/opencode
```

## First time setup (only do this once)
```bash
git remote add upstream https://github.com/anomalyco/opencode
```

## Every time you want to sync

### 1. Stash any uncommitted changes
If you have uncommitted work (check with `git status`), stash it first:
```bash
git stash --include-untracked -m "pre-rebase stash"
```
Git won't let you rebase with uncommitted changes. Stash saves them in a temporary drawer.

### 2. Fetch and rebase
```bash
git fetch upstream
git checkout dev
git rebase upstream/dev
```

### 3. Resolve conflicts (if any)
```bash
# 1. Fix the conflicts in your editor
# 2. Stage the resolved files:
git add <resolved-file>
# 3. Continue the rebase:
git rebase --continue

# If you want to abort and start over:
git rebase --abort
```

Common conflicts: upstream uses SQLite/Drizzle, we use Convex. Always keep the Convex version in our modified files.

### 4. Restore your stashed changes
```bash
git stash pop
```
If stash pop has conflicts, resolve them the same way (edit file, `git add`), then `git stash drop` to clear it.

### 5. Force push
```bash
git push origin dev --force
```
Note: A pre-push hook runs `bun turbo typecheck`. If it fails, fix the type errors and retry.

## Verify it worked
```bash
git log --oneline -10
# Your Finny commits should appear at the top, upstream commits below
```

## Tips
- Always commit or stash before rebasing. Never rebase with a dirty working tree.
- After rebase, check if upstream added new fields to tables we've ported to Convex (sessions, projects, etc.) — you may need to update `convex/schema.ts` and the Convex client wrappers.
- New files we added (in `packages/finny-*`, `.agents/`, `convex/`, Finny prompt files) won't conflict because they don't exist upstream.
