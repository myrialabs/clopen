# Maintainers Guide

Internal guide for Clopen core maintainers. External contributors should follow [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Table of Contents

- [Roles & Permissions](#roles--permissions)
- [Guiding Principles](#guiding-principles)
- [The PR Lifecycle](#the-pr-lifecycle)
  - [1. Intake](#1-intake)
  - [2. Audit](#2-audit)
  - [3. Choose a Review Path](#3-choose-a-review-path)
  - [4. Merge](#4-merge)
- [Review Paths](#review-paths)
  - [Path A — Iterate on the Branch](#path-a--iterate-on-the-branch)
  - [Path B — Comment and Wait](#path-b--comment-and-wait)
  - [Path C — Close and Replace](#path-c--close-and-replace)
- [Security PRs](#security-prs)
- [Communication Norms](#communication-norms)
- [Operational Policy](#operational-policy)
  - [Force-Push](#force-push)
  - [Conflict Resolution Between Maintainers](#conflict-resolution-between-maintainers)
- [Reference](#reference)
  - [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format)
  - [Release Process](#release-process)
  - [Questions](#questions)

---

## Roles & Permissions

| Role | Permissions |
|------|-------------|
| Maintainer | Review, request changes, push to contributor forks (when allowed), squash-merge to `main`. |
| Reviewer | Review and approve PRs. No merge rights. |

The maintainer list is managed via GitHub repo settings (Teams / Collaborators).

---

## Guiding Principles

These principles inform every decision in this guide. Cite them in a PR comment when justifying an unusual call.

- **Audit before asking the contributor to validate.** Discovering the shape needs to change after they've already re-tested wastes their time. The audit is the maintainer's responsibility, not the contributor's.
- **Default to the established pattern.** Inconsistency between sites handling the same concern is a recurring source of regressions. New mechanisms need explicit justification before they're adopted.
- **Stay persuadable until you've decided.** If a comment raises concerns, it should also state what would change your mind. If you can't articulate that, you've already decided — pick a different path.
- **Closure is administrative, not adversarial.** A closed PR can always be reopened. Frame closure as housekeeping with the door open, never as rejection.
- **Attribution always.** Whether you build on a contributor's branch or close-and-replace, the original audit instinct still earns credit.
- **Tone matters under disagreement.** Acknowledge effort first, state concerns with file/line references second, invite counterargument third.

---

## The PR Lifecycle

This is the standard flow for a fork-originated PR. Each step links to its full procedure.

### 1. Intake

Check out the PR to your local working copy:

```bash
gh pr checkout <PR-NUMBER>
```

This sets the branch's push remote to the contributor's fork, so any push goes back to the PR. Verify with:

```bash
git config branch.<branch-name>.pushRemote
```

Read the full diff before forming a position. Do not skim, do not draft comments until you've read the entire patch end-to-end.

### 2. Audit

After reading the diff, evaluate two things **before** asking the contributor to validate or iterate:

1. **Adjacent code** — search the codebase for similar gaps the PR didn't address. Bugs of the same shape usually cluster; if one site needed fixing, others likely do too. This matters most for security and refactor PRs.
2. **Adjacent patterns** — does the PR introduce a new mechanism where an established pattern in the codebase already covers this class of problem? Default to the established pattern unless the contributor can articulate why it doesn't fit.

The audit is what determines the review path. Skipping it and going straight to "looks good, please test" is the most common cause of churn.

### 3. Choose a Review Path

| Situation | Path |
|-----------|------|
| Audit is clean — no adjacent gaps, established patterns followed, scope appropriate | Approve and proceed to [Merge](#4-merge) |
| Same shape, small additions / fixes needed, contributor is engaged | [Path A — Iterate on the Branch](#path-a--iterate-on-the-branch) |
| Out-of-scope items found in the audit | File a separate PR after this one merges |
| Concerns are substantive but you may be missing context, **or** part of the PR is mergeable while another part needs discussion | [Path B — Comment and Wait](#path-b--comment-and-wait) |
| Structural approach needs to change, or you'd be rewriting most of the diff yourself | [Path C — Close and Replace](#path-c--close-and-replace) |

The happy path (direct merge) is the goal — Paths A through C exist for when the audit surfaces something that warrants intervention. If you're unsure whether intervention is needed but lean toward "something feels off", default to Path B — it preserves optionality without committing to a direction.

### 4. Merge

When the PR is ready:

- **Strategy:** Always squash-merge via the GitHub UI.
- **Subject:** Use GitHub's default (`<PR title> (#NNN)`). The PR title must already follow the conventional commit format from [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Extended description:** Leave empty. Repo convention is subject-only — check recently-merged PRs on `main` if unsure of the current style. Detail belongs in the PR description, not duplicated into the commit body. **Exception:** `Co-authored-by:` trailer when the PR is a reshape of a contributor's earlier work — see [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format).
- **Branch deletion:** Delete the source branch via the GitHub button immediately after merge.

#### Local cleanup

```bash
git checkout main
git pull origin main
git branch -D <merged-branch>
```

---

## Review Paths

### Path A — Iterate on the Branch

Use when the PR's shape is right and only needs additions or small fixes. Requires `maintainerCanModify: true` (default for fork PRs unless the contributor opted out).

#### Procedure

```bash
# 1. Make your edits locally

# 2. Verify locally
bun run check && bun run lint && bun run build

# 3. Commit a NEW commit (do NOT amend the contributor's)
git add -A
git commit -m "<type>(<scope>): description"

# 4. Sync with upstream main (resolve conflicts locally, not in the GitHub UI)
git fetch origin main
git merge origin/main
bun run check && bun run lint && bun run build   # re-verify after merge

# 5. Push to the contributor's fork
git push
```

Use `merge` (not `rebase`) when syncing with `main` to preserve the contributor's commit hashes.

#### Post-push comment

Post a comment via the **GitHub PR UI** describing what changed (see [Communication Norms](#communication-norms) for why the UI, not the CLI). Suggested format:

```markdown
Hi @contributor, thanks for this contribution. I built on top of your commit with a few additional fixes — everything is pushed to this branch.

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

### Path B — Comment and Wait

Use when concerns are substantive but the contributor may have context or reasoning you're missing — or when part of the PR is clearly mergeable while another part needs discussion. This path sits between Path A (you're confident, just iterate) and Path C (you're confident, just replace).

**Defining trait:** you'd update your position if the contributor brought a stronger argument. If you can't articulate what would change your mind, you've already decided — use Path A or C.

#### Writing the comment

Post via the **GitHub PR UI**. Structure:

1. **Acknowledge the work** in one line. The contributor put real time in; lead with that.
2. **Approve the parts that are clearly right** with concrete next steps (e.g. *"please open a separate PR covering these additional N sites"*). The merge path should be visible to the contributor by the time they finish reading.
3. **State concerns about the rest** with file/line references — auditable, not opinion. Frame as concerns: *"I have some concerns"*, *"I might be missing something"*, *"would value your reasoning"*. Use definite framing only where you're certain.
4. **Invite the counterargument explicitly.** Name the question that would change your mind: *"if you have a concrete scenario where X applies here, I'd like to hear it."* This is what distinguishes Path B from a soft close.
5. **State the next step and a deadline.** Without a deadline the PR stalls; with one, silence becomes a decision.

#### Deadlines and auto-stale

- **Default response window:** 1 week from the comment date. Adjust up for holiday periods or complex PRs, down for trivial clarifications.
- **Phrasing template:** *"Please share your thoughts by YYYY-MM-DD. If we don't hear back by then I'll close this PR as auto-stale — you're welcome to reopen or resubmit whenever it's convenient."*
- **After the deadline,** close the PR via the GitHub UI with a brief, polite note referring back to the previous comment. The contributor can reopen at any time.

GitHub has no native auto-close — track these manually (calendar reminder, scheduled task, or a weekly maintainer sweep over open PRs with stale comments).

#### If the contributor responds with a stronger argument

Update your position openly. The point of Path B is to actually be persuadable — if a credible counterargument arrives, acknowledge it and adjust (merge as-is, bundle differently, etc.). Name the change explicitly in your next comment (*"you're right that X — happy to keep both in this PR"*) so the trail is legible to anyone reviewing the discussion later.

If you find yourself rejecting every counterargument regardless of merit, you should have used Path C — and the contributor's time was wasted in the back-and-forth.

### Path C — Close and Replace

Use when the audit reveals the PR's shape needs to change — different mechanism than the established pattern, scope expanded beyond what the contributor can reasonably reach (e.g. frontend changes on a backend-only PR), or knock-on consequences that can't be fixed by stacking commits.

#### Iterate vs close-and-replace

| Iterate on branch (Path A) | Close and replace (Path C) |
|---|---|
| Same shape, small additions / fixes | Different mechanism from the established pattern |
| Scope unchanged | Scope expanded into different files/areas the contributor can't easily test |
| Contributor has bandwidth and is engaged | You'd be rewriting most of the diff yourself |
| One review round resolves it | You've already changed your mind once after asking them to validate |

If you've already asked the contributor to validate and you're now reconsidering the approach, **stop and re-audit first** — don't ask for a second validation round on a direction you're not confident in.

#### Closing courtesy

Post the closing comment via the **GitHub PR UI**. Tone matters — the contributor identified a real gap; you're reshaping the fix, not rejecting the intent. Include:

- **Apology if you changed your mind** after the contributor already validated. Own the reversal explicitly; don't frame it as if the new pattern was always obvious.
- **Why** the shape needs to change, with file/line references — auditable, not opinion.
- **What you'll do instead** — branch name, scope, and confirmation that you'll credit the contributor in the replacement PR. This makes the closure feel like continuation, not dismissal.

#### Attribution in the replacement PR

The contributor must still get credit for spotting the issue, even if no line of their code survives in the replacement.

**In the replacement PR description** (under `## Notes` or `## Related`):

```markdown
Builds on #NNN by @username, reshaped after review to <one-sentence reason>.
```

This creates two-way cross-links: the closed PR shows "Referenced in PR #MMM", and the new PR shows the original as context.

**At squash-merge time,** add a `Co-authored-by:` trailer to the squash commit body. This is the **only acceptable exception** to the "leave extended description empty" rule. See [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format) for the strict format.

---

## Security PRs

Extra discipline applies on top of the standard lifecycle:

- **Audit adjacent code.** IDOR-style bugs, privilege-escalation patterns, and input-validation gaps usually cluster. If one site needed the fix, search the codebase for the same shape elsewhere before merging.
- **Audit frontend visibility** when restricting a backend route. The same route is typically reached from many UI surfaces — open polling, status badges, navigation entry points, deep-linked modals, auto-mounted stores — any of which will surface an unexpected authorization error to users who previously had access. Test the gated route end-to-end from the perspective of the now-restricted role (full UI walkthrough, not just the API/WS call), not just from the perspective of a role that still has access. This is a recurring regression class on any authorization change.
- **Prefer established patterns.** The codebase has settled patterns for different authorization classes — explicit allowlists for global/system mutations, per-resource access helpers for user-owned resources, default-open for benign reads. A new security PR should fit one of these existing classes; if a contributor introduces a new mechanism, ask why the established pattern doesn't cover the case before adopting the new shape.
- **Match the defense to the threat.** A textbook-correct hardening pattern can still be wrong for the specific code path it's applied to — what's being compared, what an attacker can actually steer, and what the new code costs on the hot path all matter. Ask the contributor for an explicit threat model before merging, especially when the fix replaces an indexed lookup with a scan or otherwise trades performance for hardening.
- **Surface DB-layer bypasses** in the PR comment even when fixed (e.g. implicit grants from upsert/ignore patterns, missing transaction boundaries, ORM defaults that skip validation).
- **Require a threat model** in `## Security impact`: who is the attacker, what can they reach now, what is closed by this PR.
- **Scope discipline.** If the audit finds out-of-scope issues, file separate PRs immediately rather than letting the original PR balloon.
- **No public CVE-style disclosure** in the PR description until the fix has shipped to a release. Use neutral framing (*"hardens authorization checks"*) instead of attack details.

---

## Communication Norms

Cross-cutting rules that apply across all review paths.

- **Post review comments via the GitHub PR UI**, not `gh pr comment`. Markdown previews and `@mention` notifications behave differently between the two — the CLI path silently drops or mangles formatting that the UI gets right.
- **Lead with acknowledgement, end with next steps.** This holds whether you're approving, requesting changes, asking for discussion, or closing.
- **Use file:line references** instead of free-form prose when describing technical issues. The diff is the source of truth; pointing to it makes the comment auditable.
- **Resolve conflicts locally**, not in the GitHub web UI. Web-resolved merges drop signing and bypass local checks.
- **Never use `--no-verify`** or otherwise skip pre-commit hooks. If a hook fails, fix the underlying issue.

---

## Operational Policy

### Force-Push

- **Never** force-push to `main`.
- Force-pushing to a contributor's fork branch is permitted only when rebasing solves a real problem **and** you've coordinated with the contributor first. Default to `merge` to preserve commit hashes.

### Conflict Resolution Between Maintainers

If two maintainers disagree on a merge decision:

1. Move the discussion into the PR comments so it's recorded.
2. If unresolved within 24 hours, escalate to the project lead.
3. **Default action:** do not merge until consensus is reached.

---

## Reference

### `Co-authored-by` Trailer Format

Used in squash-commit bodies when attributing a contributor whose PR was closed and reshaped (see [Path C — Close and Replace](#path-c--close-and-replace)). Format is strict — GitHub silently drops malformed trailers.

```
Co-authored-by: Full Name <email@example.com>
```

Rules:

- Header is `Co-authored-by:` exactly (capital `C`, lowercase rest, single space after the colon).
- Email wrapped in `<>` with no spaces inside, preceded by one space after the name.
- Use the email associated with the contributor's GitHub account. Check their commits on the closed PR:
  ```bash
  git log <branch> -1 --format='%ae'
  ```
- If the squash body has other text, separate the trailer with one blank line above it.

**Verify after merge.** Open the squash commit on `main` and confirm the contributor's avatar appears next to the "Co-authored by" line. If only your avatar shows, the trailer didn't parse. Fixing this after the fact requires rewriting `main` history, so check before walking away from the merge.

### Release Process

To be documented when the release flow stabilizes.

### Questions

Internal team: use the team Slack/Discord channel.
