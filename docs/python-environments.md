# Python environment storage and reclaim

Finny stores one content-addressed Python environment per exact package set at
`$FINNY_HOME/python-envs/<package-set-hash>`. Algo workspaces reference that
shared environment; new workspaces no longer create their own `.venv`.

Environment creation and reclaim use the same cross-process filesystem lock.
Running Finny processes also hold PID leases so an environment cannot be
reclaimed while it is in use. When the uv cache and environment are on the same
filesystem, installs explicitly use uv's hardlink mode.

If a process stops during first-time creation, the next run recognizes the
Finny build sentinel, atomically moves the partial directory to an
`.incomplete-*` quarantine path, and builds cleanly. An unmarked directory at a
shared-environment path is never changed automatically.

## Reclaim old environments

The reclaim command is a dry run unless both deletion flags are supplied:

```sh
finny algo env reclaim
finny algo env reclaim --apply --yes
```

The report includes exact paths and byte counts. The apply pass revalidates
every candidate after acquiring its lock and skips anything that changed or
became active after planning.

Legacy workspace `.venv` directories are eligible only when all of these are
true:

- the parent is a recognized algo workspace under Finny's configured algos root;
- the environment is a real directory, not a symlink;
- its Finny marker and Python path match that exact directory; and
- the workspace is neither active nor bound to any persisted session.

Shared environments are retained for at least 30 days and the eight most
recently used package sets are always kept. Customize those bounds with
`--max-age-days` and `--keep-shared`.

Finny never deletes whole algo workspaces through this command. Unknown,
unmarked, malformed, symlinked, path-escaping, changed, or actively leased
directories are reported or skipped rather than removed.
