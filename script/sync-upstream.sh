#!/usr/bin/env bash
# Sync helper for the OpenCode fork. See UPSTREAM_SYNC.md for the playbook.
#
# Usage:
#   ./script/sync-upstream.sh [target-branch] [upstream-branch]
#
# Defaults: target-branch=dev, upstream-branch=dev.
# Creates sync/upstream-<date>, merges upstream, and on conflict prints the
# conflicting files annotated with their UPSTREAM_SYNC.md ledger hotspots.
set -euo pipefail

TARGET_BRANCH="${1:-dev}"
UPSTREAM_BRANCH="${2:-dev}"
UPSTREAM_URL="https://github.com/anomalyco/opencode.git"
SYNC_BRANCH="sync/upstream-$(date +%Y%m%d)"

cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree not clean — commit or stash first" >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

# Remembered conflict resolutions replay automatically on future syncs.
git config rerere.enabled true

git fetch upstream "$UPSTREAM_BRANCH"
git fetch origin "$TARGET_BRANCH"

BEHIND=$(git rev-list --count "origin/$TARGET_BRANCH..upstream/$UPSTREAM_BRANCH")
if [ "$BEHIND" -eq 0 ]; then
  echo "Already up to date with upstream/$UPSTREAM_BRANCH."
  exit 0
fi
echo "Fork is $BEHIND commits behind upstream/$UPSTREAM_BRANCH."

git switch -c "$SYNC_BRANCH" "origin/$TARGET_BRANCH"

if git merge --no-edit "upstream/$UPSTREAM_BRANCH"; then
  echo
  echo "Clean merge. Now run the verification gate (UPSTREAM_SYNC.md):"
  echo "  bun install && bun run typecheck"
  echo "  cd packages/opencode && bun test"
  echo "Then push and open a PR:"
  echo "  git push -u origin $SYNC_BRANCH"
  exit 0
fi

echo
echo "Merge has conflicts. Conflicting files (see UPSTREAM_SYNC.md ledger):"
echo

# Hotspots from the divergence ledger; anything matching gets flagged so the
# resolver knows a Finny invariant is at stake.
HOTSPOTS='src/agent/agent.ts|src/tool/(shell|bash|read|edit|write|task|registry)\.ts|src/session/prompt|httpapi/(groups|handlers)/config|tui/src/(routes/settings|context/route)|dialog-settings|settings-agents|package\.json|\.gitignore'

git diff --name-only --diff-filter=U | while read -r file; do
  if echo "$file" | grep -qE "$HOTSPOTS"; then
    echo "  [LEDGER] $file"
  else
    echo "           $file"
  fi
done

echo
echo "Resolve per the playbook (upstream wins on structure, Finny wins on"
echo "behavior), then: git add -A && git commit, run the verification gate,"
echo "and push. Aborting leaves you on $SYNC_BRANCH; use 'git merge --abort'"
echo "to back out."
exit 2
