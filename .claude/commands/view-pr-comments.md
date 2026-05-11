---
description: Pull all review comments on the current branch's PR, then fix every actionable one
argument-hint: "[pr-number]"
---

You are addressing reviewer feedback on a GitHub pull request. The user wants every actionable comment fixed, the typecheck passing, and the result pushed back to the same PR branch.

# Step 1 — Identify the PR

Determine which PR to act on, in this order:

1. If the user passed `$1` (a PR number), use that.
2. Otherwise, run `git branch --show-current` and `gh pr view --json number,headRefName,baseRefName,url,state` to find the open PR for the current branch.
3. If no PR exists, stop and tell the user. Do NOT create one — they didn't ask for that.

Confirm the PR with the user briefly: number, title, base branch. Do not wait for approval; proceed.

# Step 2 — Pull every comment

Fetch BOTH comment surfaces — the GitHub API splits them:

- **Review comments** (inline, attached to specific file+line): `gh api "repos/{owner}/{repo}/pulls/{pr}/comments" --paginate`
- **Issue comments** (general PR discussion): `gh api "repos/{owner}/{repo}/issues/{pr}/comments" --paginate`
- **Reviews** (the per-review summaries that often hold the body of CI/Copilot reviews): `gh api "repos/{owner}/{repo}/pulls/{pr}/reviews" --paginate`

Use `gh repo view --json nameWithOwner` to get the {owner}/{repo} slug — the default repo `gh` resolves may be a fork or upstream, so always pin it explicitly with `--repo {owner}/{repo}` on the comment fetches when the branch lives on a fork.

Filter out:
- Comments authored by yourself or any prior fix-PR bot commits (look at `user.login` and `body`)
- Comments marked `state: "RESOLVED"` (review comments expose this on `pull_request_review_thread` — fetch via GraphQL if the REST `position` is null, that usually means resolved/outdated)
- Pure approvals / "LGTM" / "thanks" with no actionable content
- Questions you can't act on without the user's input — surface those at the end as "needs human attention"

# Step 3 — Read each comment in its code context

For every actionable review comment, do this BEFORE proposing a fix:

1. Note `path`, `line` (or `original_line` if `line` is null), and `diff_hunk` from the API response.
2. Read the file at that path, focused on a window around the relevant line. Don't trust the comment's snippet alone — the surrounding code may have changed since the review was written.
3. Understand what the reviewer asked for. Distinguish:
   - **Bug fix** — they're flagging a real defect. Apply.
   - **Style / readability** — apply if the suggestion is concrete and clearly non-controversial. Skip if it's preference or would expand scope.
   - **Suggestion / "consider"** — apply only if the reasoning is sound; otherwise note in the summary that it was considered and skipped.
   - **Question** — ask the user (don't invent an answer).

# Step 4 — Apply fixes

For each accepted fix:

1. Use `Edit` or `Write` to make the change. Match existing style and patterns nearby.
2. Add a brief comment ONLY when the WHY is non-obvious or when the reviewer specifically asked for one. Don't add noise.
3. Group related fixes in the same file into a single edit when possible.

After all edits:

- Run the project's typecheck. Look at recent shell history or `package.json` scripts to find the right command. For this repo it's `bun turbo typecheck`. If the project uses husky pre-push hooks, expect the hook to run typecheck — fix any failures it surfaces before pushing.
- If the project has a quick lint or test command and it's reasonable, run that too. Don't run a full integration suite unless the user asks.

# Step 5 — Commit and push

- Single commit, conventional plain English title (no `feat:`/`fix:` prefix unless the repo's existing log uses them — check `git log --oneline -5` first).
- Title: `Address {reviewer/Copilot} review feedback on PR #{number}`. If multiple reviewers, just say "review feedback".
- Body: bulleted list of each fix, one line per file/concern, brief and specific. Reference what the reviewer flagged so the trail is searchable.
- Read `CLAUDE.md` (if present) for commit-message rules. In particular: NO `Co-Authored-By: Claude` trailer, NO "🤖 Generated with [Claude Code]" footer.
- Use `git commit -m "$(cat <<'EOF'\n...\nEOF\n)"` HEREDOC for multi-line.
- Push to the same branch with `git push origin <branch>`. Do NOT force-push.

# Step 6 — Report

Reply to the user with:

- The PR URL.
- Bulleted list of fixes that landed.
- Bulleted list of comments you intentionally skipped (with one-line reason each).
- Bulleted list of comments that need their attention (questions, ambiguous asks).

# Guardrails

- **Never bypass hooks** — no `--no-verify`, no `--no-gpg-sign`. If a hook fails, fix the underlying issue.
- **Never force-push** to the PR branch unless the user explicitly asks (would clobber other people's commits or amend a published commit).
- **Don't merge the PR.** Just push the fixes; merge is the user's call.
- **Don't request changes / approve / dismiss** other reviews. You're a contributor, not a reviewer.
- **Don't reply to comments via `gh pr comment`** unless the user asks. The push + commit message is the response.
- **If you stage and the diff includes files you didn't intend to touch** (other in-progress work, secrets, etc.), back out and stage selectively by path.
- **If `gh` resolves to the wrong repo** (default is upstream/fork), specify `--repo {owner}/{repo}` on every API call to avoid silently failing with `Head sha can't be blank` or similar.
