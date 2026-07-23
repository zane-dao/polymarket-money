---
name: merge-pr
description: Verify and merge a GitHub pull request for polymarket-money. Use when the user says merge, merge PR, 合并, 该 merge merge, finish the PR, or explicitly invokes $merge-pr. Resolve the exact PR, target, checks, mergeability, validation evidence, and known risks before merging; never treat an ordinary coding request as merge authorization.
---

# Merge PR

Use `gh` and non-interactive Git commands. Never expose authentication tokens.

## Workflow

1. Run `git status --short`, `git branch --show-current`, `git remote -v`, `gh auth status`, and `gh pr status`.
2. Resolve one exact PR. Verify its head is the intended branch and its base is `main`. Stop on ambiguity.
3. Inspect the PR with `gh pr view` and report:
   - PR number and URL
   - base and head branches
   - draft and mergeability state
   - review decision and required checks
   - validation results and known limitations from the current task
4. Require explicit merge authorization in the current conversation. Phrases such as `merge`, `合并`,
   `该 merge merge`, or direct `$merge-pr` invocation with an identified PR count as authorization.
   Creating a PR, pushing a branch, or asking for status does not.
5. Do not merge when:
   - required checks failed or are still pending;
   - the PR is draft, conflicted, closed, or targets an unexpected base;
   - unrelated uncommitted changes would be lost or included;
   - the validation evidence materially contradicts the PR description.
6. When checks pass and authorization exists, run:

   ```bash
   gh pr merge <number> --merge --delete-branch
   ```

   Preserve merge commits to match this repository's normal history. Do not force-push or bypass branch
   protection.
7. Verify `state=MERGED`, record the merge commit, fetch `origin`, and confirm the merge commit is reachable
   from `origin/main`. Do not switch or reset a dirty worktree.

## Missing PR

If the intended changes are committed but no PR exists, push the current topic branch and create a PR only
when the user asked to finish or merge the current work. Include summary, validation, Paper-only boundary,
and known limitations. Then return to the workflow above.

## Output

Lead with `MERGED`, `NOT MERGED`, or `BLOCKED`. Include the PR link, merge commit when available, checks,
and any remaining local or deployment work.
