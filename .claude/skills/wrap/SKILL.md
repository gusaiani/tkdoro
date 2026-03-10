---
name: wrap
description: Ship current changes, merge the PR immediately, then sync main locally. Use at end of a work session to fully close out a branch.
---

Commit all changes, push, open a PR against main, merge it immediately, then sync main locally.

## Steps

1. **Ship** — run the `ship` skill to commit, push, and create the PR. Do NOT include a test plan in the PR body.

2. **Merge immediately** — run:
   ```
   gh pr merge <number> --squash --admin
   ```

3. **Sync** — run the `sync-from-main` skill to pull main locally.

4. Report the PR URL and confirm main is up to date.
