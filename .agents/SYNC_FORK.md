# Sync Fork with Upstream

## Steps to sync `dev` branch with upstream `anomalyco/opencode:dev`

### First time setup (only do this once)
```bash
git remote add upstream https://github.com/anomalyco/opencode
```

### Every time you want to sync
```bash
git fetch upstream
git checkout dev
git rebase upstream/dev
git push origin dev --force
```

### If you hit merge conflicts
```bash
# 1. Fix the conflicts in your editor
# 2. Then run:
git add .
git rebase --continue

# If you want to abort and start over:
git rebase --abort
```

### Verify it worked
```bash
git log --oneline -10
# Your commits should appear at the top, upstream commits below
```
