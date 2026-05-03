# Maintainers Guide

Internal guide for Clopen core maintainers. External contributors should follow [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Roles

| Role | Rights |
|------|--------|
| Maintainer | Review, request changes, push to contributor forks (when allowed), squash-merge to `main`. |
| Reviewer | Review and approve PRs. No merge rights. |

Maintainer list is managed via GitHub repo settings (Teams / Collaborators).

---

## Receiving a Pull Request from a Fork

### 1. Checkout the PR locally

```bash
gh pr checkout <PR-NUMBER>
```

This sets the branch's push remote to the contributor's fork, so any push goes back into the PR. Verify with:

```bash
git config branch.<branch-name>.pushRemote
```

### 2. Audit scope

After reading the diff, audit adjacent code for similar gaps the PR didn't address — especially for security or refactor PRs. Decide:

- **Bundle into this PR** — same theme, same risk class, contributor agrees → add commits on top of the existing branch.
- **Separate PR** — out-of-scope items get a follow-up PR after this one merges.

When in doubt, ask in the PR comments before adding commits.

### 3. Adding fixes on top of a contributor's PR

Only when `maintainerCanModify: true` (default for fork PRs unless contributor opts out).

```bash
# 1. Make your edits locally
# 2. Verify
bun run check && bun run lint && bun run build

# 3. Commit your own commit (do NOT amend the contributor's)
git add -A
git commit -m "<type>(<scope>): description"

# 4. Sync with upstream main (resolve conflicts locally, not in GitHub UI)
git fetch origin main
git merge origin/main
bun run check && bun run lint && bun run build   # re-verify after merge

# 5. Push to the contributor's fork
git push
```

Use `merge` (not `rebase`) when syncing with `main` to preserve the contributor's commit hashes.

### 4. Post a PR comment describing what changed

Comment via the **GitHub PR UI** (not `gh pr comment`) so markdown previews and `@mention` notifications behave correctly.

Use this format so the contributor knows exactly what was added:

```markdown
Hi @contributor, thanks a lot for this contribution! I built on top of your commit with a few additional fixes — everything has been pushed to this branch.

## Summary
…

## Why
…

## Changes
- …

## Notes
- `bun run check` and `bun run lint` both pass clean.
- N files changed, +X/-Y.
- Branch synced with latest `main`.
```

The same optional headers from [CONTRIBUTING.md → Pull Request Format](./CONTRIBUTING.md#pull-request-format) apply (`## Security impact`, `## Test plan`, etc.).

---

## Merging to `main`

- **Strategy:** Always squash-merge.
- **Subject:** GitHub's default (`<PR title> (#NNN)`) — leave as is. PR title must already follow the conventional commit format.
- **Extended description:** Leave empty. Repo convention is subject-only — see merged PRs (#220, #224) for reference. Detail belongs in the PR description, not duplicated into the commit body.
- **Branch deletion:** Delete the source branch via the GitHub button after merge.

### Local cleanup

```bash
git checkout main
git pull origin main
git branch -D <merged-branch>
```

---

## Force-Push Policy

- **Never** force-push to `main`.
- Force-pushing to a contributor's fork branch is allowed only when rebasing solves a real problem, and only after coordinating with the contributor. Default to `merge` to preserve commit hashes.
- Never use `--no-verify` or skip pre-commit hooks.

---

## Security PRs

Extra discipline applies:

- **Audit adjacent code** before merging — IDOR-style bugs, privilege-escalation patterns, and input-validation gaps usually cluster.
- **Surface DB-layer bypasses** in the PR comment even when fixed (e.g. `INSERT OR IGNORE`-style implicit grants, missing transaction boundaries).
- **Threat model** in `## Security impact`: who is the attacker, what can they reach now, what is closed by this PR.
- **Scope discipline:** if the audit finds out-of-scope issues, file separate PRs immediately rather than letting the original PR balloon.
- **No public CVE-style disclosure** in the PR description until the fix has shipped to a release; use neutral framing ("hardens authorization checks") instead of attack details.

---

## Conflict Resolution Between Maintainers

If two maintainers disagree on a merge decision:

1. Move the discussion into the PR comments so it's recorded.
2. If unresolved within 24h, escalate to the project lead.
3. Default action: do not merge until consensus is reached.

---

## Release Process

(To be documented when the release flow stabilizes.)

---

## Questions?

Internal team: use the team Slack/Discord channel.
