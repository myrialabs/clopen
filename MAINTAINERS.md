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
  - [Path A — Approve and Merge](#path-a--approve-and-merge)
  - [Path B — Iterate on the Branch](#path-b--iterate-on-the-branch)
  - [Path C — Merge As-Is, Follow-up PR](#path-c--merge-as-is-follow-up-pr)
  - [Path D — Comment and Wait](#path-d--comment-and-wait)
  - [Path E — Close and Replace](#path-e--close-and-replace)
  - [Path F — Close as Not Actionable](#path-f--close-as-not-actionable)
- [Security PRs](#security-prs)
- [Communication Norms](#communication-norms)
  - [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections)
  - [Suggest by Default; Act on Confirmation](#suggest-by-default-act-on-confirmation)
- [Operational Policy](#operational-policy)
  - [Force-Push](#force-push)
  - [Conflict Resolution Between Maintainers](#conflict-resolution-between-maintainers)
- [Reference](#reference)
  - [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format)
  - [Release Process](#release-process)
  - [Publishing the Memory Graph Embedding Artifact](#publishing-the-memory-graph-embedding-artifact)
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
- **Warm, brief, substantive — in that order.** Open with one or two sentences that recognize something *specific* the contributor did well (the security instinct, the careful edge-case writeup, the test scaffolding). Generic "thanks for the PR" reads as filler; named appreciation lands. Then shape the body to the substance: a single concern reads as a short paragraph; multiple concern classes (blockers + minor + please-add) get topic sections (`## Blockers`, `## Minor`, etc.) so reviewers can scan. One issue per paragraph either way, file:line inline, no restated context, no "I want to merge this, but..." padding. See [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections) for the full pattern. Write the comment a senior engineer would feel respected receiving.

---

## The PR Lifecycle

This is the standard flow for a fork-originated PR.

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

After reading the diff, evaluate four things **before** asking the contributor to validate or iterate:

1. **Adjacent code** — search the codebase for similar gaps the PR didn't address. Bugs of the same shape usually cluster; if one site needed fixing, others likely do too. This matters most for security and refactor PRs.
2. **Adjacent patterns** — does the PR introduce a new mechanism where an established pattern in the codebase already covers this class of problem? Default to the established pattern unless the contributor can articulate why it doesn't fit.
3. **Test coverage** — does the change include `*.test.ts` where [CONTRIBUTING.md → Tests](./CONTRIBUTING.md#tests) expects them? If a test is missing, decide whether you add it on the branch ([Path B](#path-b--iterate-on-the-branch)) or request it from the contributor ([Path D](#path-d--comment-and-wait)). Security PRs without a regression test are not merge-ready.
4. **Before/after failure scenario** — walk through at least one real-case scenario in user-visible terms, showing what happens **without** the PR and what changes **with** it. The audit isn't complete until you can articulate the failure as concrete steps (who does what, what state results, which `file.ts:LL` holds that state) and the fix as the same steps under the new behavior. Deliver this inline with the audit findings — don't wait for the maintainer to ask. It also seeds the regression test in step 3: if a contributor wouldn't know where to start writing the test, the scenario you walked through usually shows them.

   Shape:

   > *"User does X (at `path/to/file.ts:LL`, state Y is created). Triggers Z.*
   > ***Without PR:** Y persists / leaks / misbehaves → [observable consequence — orphaned map entry, stale subscription, wrong UI state, etc.].*
   > ***With PR:** Y is cleaned up at [new code location, `path/to/fix.ts:LL`]; next observation confirms clean state."*

   When the fix depends on a non-obvious guard (e.g. why `mode: 'remove'` is intentionally excluded from a cleanup path), add a second scenario showing what would break if the guard were dropped. This is how reviewers later understand *why* the guard is load-bearing instead of treating it as defensive sugar that can be relaxed.

The audit is what determines the review path. Skipping it and going straight to "looks good, please test" is the most common cause of churn.

### 3. Choose a Review Path

| Situation | Path |
|-----------|------|
| Audit is clean — no adjacent gaps, established patterns followed, scope appropriate | [Path A — Approve and Merge](#path-a--approve-and-merge) |
| Same shape, small additions / fixes needed, contributor is engaged | [Path B — Iterate on the Branch](#path-b--iterate-on-the-branch) |
| Out-of-scope items found in the audit | [Path C — Merge As-Is, Follow-up PR](#path-c--merge-as-is-follow-up-pr) |
| Concerns are substantive but you may be missing context, **or** part of the PR is mergeable while another part needs discussion | [Path D — Comment and Wait](#path-d--comment-and-wait) |
| Structural approach needs to change, or you'd be rewriting most of the diff yourself | [Path E — Close and Replace](#path-e--close-and-replace) |
| The PR's premise doesn't hold — the bug isn't real, the behavior is intentional, or the fix is worse than the issue — and no replacement is warranted | [Path F — Close as Not Actionable](#path-f--close-as-not-actionable) |

The happy path ([Path A](#path-a--approve-and-merge)) is the goal — the other paths exist for when the audit surfaces something that warrants intervention. If you're unsure whether intervention is needed but lean toward "something feels off", default to [Path D](#path-d--comment-and-wait) — it preserves optionality without committing to a direction. Path F requires the opposite of Path D's defining trait: you must be able to articulate, with file:line evidence, *why* the premise doesn't hold. If you can't, you're in Path D territory, not Path F.

### 4. Merge

When the PR is ready:

- **Strategy:** Always squash-merge via the GitHub UI.
- **Subject:** Use GitHub's default (`<PR title> (#NNN)`). The PR title must already follow the conventional commit format from [CONTRIBUTING.md → Commit Messages](./CONTRIBUTING.md#commit-messages).
- **Extended description:** Carry the commit body — what was broken, why, and what the change does about it, per [CONTRIBUTING.md → Commit Body](./CONTRIBUTING.md#commit-body). GitHub pre-fills this box with every commit message from the branch; replace that with a single clean body rather than shipping the concatenation. Leave it empty only when the subject is the whole story (dependency bump, release, typo). Review-time detail — test plan, screenshots, follow-ups — stays in the PR description and does not belong here. Check recently-merged commits on `main` if unsure of the current style.
- **`Co-authored-by:` trailer:** Required when the PR is a reshape of a contributor's earlier work — see [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format).
- **Branch deletion:** Delete the source branch via the GitHub button immediately after merge.

#### Local cleanup

```bash
git checkout main
git pull origin main
git branch -D <merged-branch>
```

---

## Review Paths

Five paths, one per row of [Choose a Review Path](#3-choose-a-review-path). Each subsection is self-contained: when to use it, the procedure (if any git ops), and a worked example comment.

Worked examples are illustrative templates, not literal copy-paste. The recurring placeholders are `@contributor`, `#NNN`, `path/to/file.ts:LL`, and dates (always plain English on the PR — `May 25, 2026` — not ISO). Anywhere an example contains an angle-bracket slot like `<the specific flow>` or a concrete-looking name (helper, function, scenario, error string) that varies per PR, treat it as a placeholder — substitute what's actually in the PR you're reviewing. Structural elements like `## Headers`, `### N.` numbering, `**Sub-group:**` labels, and the framing sentences around examples are the lesson; keep those literal. All comments are posted via the GitHub PR UI per [Communication Norms](#communication-norms).

### Path A — Approve and Merge

Use when the audit is clean — no adjacent gaps, established patterns followed, scope appropriate, and tests are present where [CONTRIBUTING.md → Tests](./CONTRIBUTING.md#tests) requires them. Post a short approval comment, then proceed to [Merge](#4-merge).

```markdown
Thanks @contributor — nice catch on this one, and the `<specific thing they did well>` made the audit straightforward. Checked adjacent call sites in `path/to/dir` and they all follow the same shape, no gaps. `bun run check` / `bun run lint` / `bun run test` green locally. Merging.
```

The opener has to name something specific — the regression test that pinned the boundary, the choice to follow an existing pattern, the threat model in the description. "Thanks for the PR!" alone is filler.

For security-sensitive PRs, also note that the threat model in the description matches the diff (or summarize it yourself in one sentence if the contributor didn't include one).

### Path B — Iterate on the Branch

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

Match the comment's shape to what you added. Two flavors — see [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections).

**Small follow-up** — one or two adjacent call sites, a test, a doc tweak. Prose, one paragraph after the opener. Reviewers will read the diff for the rest.

```markdown
Thanks @contributor — your fix at `path/to/file.ts:LL` was the right shape, and spotting `<what they caught>` was a good call. Built on top with the adjacent call sites at `path/to/a.ts:LL` and `path/to/b.ts:LL` that took the same shape, plus a regression test pinning `<the boundary or invariant the original fix addressed>` so the next round can't regress quietly. `bun run check` / `lint` / `test` green, synced with `main`.
```

**Substantial follow-up** — multi-file changes, adjacent gaps swept in, behavioral additions. Use the PR-description shape (`## Summary / ## Why / ## Changes / ## Security impact / ## Notes`). This is the canonical exception to "section headers belong in PR descriptions": when the comment documents a substantial set of changes, reviewers need the same scannable shape.

```markdown
Hi @contributor, thanks a lot for this contribution! I built on top of your commit with a few additional fixes — everything has been pushed to this branch.

## Summary
<One- or two-sentence summary of what the follow-up adds on top of the original PR: the pattern extended, the gap closed, the area covered.>

## Why
<The motivation: what the audit surfaced that the original diff didn't cover, why it matters, with file:line anchors for the affected sites.>

## Changes

<Group related items under bolded sub-headers when the diff spans more than one concern; one bullet per touched site. Drop the sub-headers entirely if there's only one concern and a flat bullet list reads cleaner.>

**<Sub-group label — e.g. the area or concern these changes share>:**
- `path/to/file.ts:LL` — <what you did and which helper/pattern you reused>.
- `path/to/other.ts:LL` — <same shape, if applicable>.

**<Another sub-group, if the follow-up touches a separate concern>:**
- `path/to/separate-concern.ts:LL` — <description>.

## Security impact
<One or two sentences: what's now closed, whether the follow-up aligns with or extends the original PR's threat model. Omit this section entirely if the follow-up isn't security-shaped.>

## Notes
- <Any constraint, follow-up, or context worth flagging — e.g. scope kept tight, no new helpers introduced, future work deferred to a separate PR.>
- `bun run check` and `bun run lint` pass clean. Synced with `main`.
```

The bar either way is "the contributor can read this and immediately know what's now in their branch and why."

### Path C — Merge As-Is, Follow-up PR

Use when the audit surfaces issues that share a shape with this PR but live in different files/areas the contributor didn't sign up for. Don't expand the scope of the open PR — credit the find, merge what's ready, file the follow-up separately.

```markdown
Thanks @contributor — this is a clean fix, and surfacing the pattern is honestly the more valuable half of it. Merging as-is.

While auditing I noticed two adjacent call sites that take the same shape (`path/to/x.ts:LL`, `path/to/y.ts:LL`), but they're outside what this PR signed up for — so I'll open a follow-up (`fix/<scope>-cover-adjacent-sites`, per [CONTRIBUTING.md → Branch Naming](./CONTRIBUTING.md#branch-naming)) and credit this PR for the find.
```

In the follow-up PR description, link back under `## Related` so the trail is legible from both sides.

### Path D — Comment and Wait

Use when concerns are substantive but the contributor may have context or reasoning you're missing — or when part of the PR is clearly mergeable while another part needs discussion. This path sits between [Path B](#path-b--iterate-on-the-branch) (you're confident, just iterate) and [Path E](#path-e--close-and-replace) (you're confident, just replace).

**Defining trait:** you'd update your position if the contributor brought a stronger argument. If you can't articulate what would change your mind, you've already decided — use [Path B](#path-b--iterate-on-the-branch) or [Path E](#path-e--close-and-replace).

#### Comment shape

Every Path D comment needs:

- **A warm, specific opener.** Name something the contributor did well — the instinct that surfaced the bug, the threat model they wrote, the test they pinned the boundary with. "Thanks for the PR" with no specifics is filler.
- **Concerns anchored to file:line**, raised conversationally inside sentences ("at `path/to/file.ts:LL`, X happens — is there a reason..."), not as bolded leads of audit bullets.
- **The question whose answer would flip your position**, woven into the relevant concern. If you can't articulate one, you've already decided — use [Path B](#path-b--iterate-on-the-branch) or [Path E](#path-e--close-and-replace).
- **A response deadline** at the end. Without one, silence becomes drift. Write the date in plain English (`May 25, 2026`), not ISO (`2026-05-25`) — ISO dates read as machine output and pull the warmth out of the closing sentence.
- **An explicit close-and-reopen consequence.** *"If you can't respond by then, I'll close this PR as auto-stale — you can reopen anytime once you're back"* is clearer than *"happy to reopen the moment you're back"*, which buries the action and reads as if the close happens by itself.
- **Adjacent out-of-scope flag + ownership offer in separate paragraphs.** The flag is audit signal; the offer is logistics — mixing them lets logistics bleed into the finding and reads as hedging.

Choose the body shape based on substance — see [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections). A single concern reads as prose. Multiple concern classes (blockers + minor + please-add + process-note) get topic sections so reviewers can scan.

**Single-issue example — one regression, one process note.** Use topic sections when concerns belong to different classes, even if there are only two.

```markdown
Hi @contributor, thanks for the fix — `<the specific thing they got right>` lands in the right place. Before we can merge, though, this PR introduces a regression that needs to be addressed.

## Regression

After applying this patch, `<the affected UI surface or flow>` fails — `<the user-visible symptom, exact error string if there is one>`. This breaks `<the broader user flow that depends on it>`, even for `<the role that still should have access>`.

**Why:** `<the route or function>` is used by `<the calling surface>` to `<what it does>` — but the new guard at `path/to/file.ts:LL` rejects this case unconditionally because `<the assumption the guard makes that doesn't hold here>`.

**Repro:** `<concrete steps a reviewer can follow to see the regression>`.

## Note on tooling

Using AI to draft patches is welcome — but please install Bun and **exercise the change in a running app** before opening the PR. Static checks don't catch UX regressions like this one, and the PR description noted you couldn't run `bun run check` locally. For security fixes especially, manual end-to-end verification is non-negotiable.

Happy to pair on the fix or take it over if it's blocking you — just let me know.

Could you take a look by May 25, 2026? If you can't respond by then, I'll close this PR as auto-stale per [Deadlines](#deadlines-and-auto-stale) — you can reopen anytime once you're back.
```

**Multi-class example — blockers, please-add items, and minor suggestions.** Use topic sections per class with `### N.` sub-issues for distinct findings inside each.

````markdown
Hi @contributor, thanks a lot for this PR — `<the specific thing they did well — the coverage, the pattern consistency, the threat model in the description>`. I audited the diff; a few items need to be addressed before this can be merged:

## Blockers

### 1. <One-line title naming the blocker — include file:line if it pins a specific site>

```
<Compiler error, test failure, or other concrete output that demonstrates the blocker, if there is one.>
```

<Prose explanation of the root cause, with file:line anchors. End with how you verified this is new to the branch ("I confirmed `main` is clean and this branch fails with the error above").>

### 2. <One-line title for the second blocker>

<Prose explanation of what's wrong, with file:line anchors. If a fix shape is non-obvious, suggest one or two options inline — "either treat X as Y at the backend, or send Z from the frontend.">

## Please add to the PR description

### <One-line title for the must-mention item>

<Why this needs to be surfaced explicitly — usually a migration consequence, a behavioral change operators need to communicate, or a known limitation. Reference the section it should go under (`## Security impact`, `## Migration`, `## Notes`) and what operators or users need to do.>

## Minor (optional, feel free to skip)

- <Short observation about a redundant check, dead code path, or cosmetic issue — one sentence, with file:line if useful.>
- <Another such observation, if applicable.>

Could you take a look by May 25, 2026? If you can't respond by then, I'll close this PR as auto-stale per [Deadlines](#deadlines-and-auto-stale) — you can reopen anytime once you're back.
````

**Single-concern, single-class example — prose, no sections.** When the comment has only one concern and no process note to bundle, the section header just adds visual weight without scanning benefit.

```markdown
Hi @contributor — thanks for digging into this; `<the specific thing they did well — the threat model in the description, the audit instinct, the test scaffolding>` made the audit easy. One thing I'd like to talk through before merging.

I don't think `<the issue the PR closes>` can actually happen in the current runtime. <Your reasoning with file:line anchors — the invariant the runtime already provides, the path you walked, why the threat model doesn't fit here.> What would flip my position: `<the concrete evidence or threat model that would make the fix necessary — a code path you might have missed, a deployment assumption that changes the calculus>`.

Could you take a look by May 25, 2026? If you can't respond by then, I'll close this PR as auto-stale per [Deadlines](#deadlines-and-auto-stale) — you can reopen anytime once you're back.
```

#### Deadlines and auto-stale

- **Default response window:** 1 week from the comment date. Adjust up for holiday periods or complex PRs, down for trivial clarifications.
- **After the deadline,** close the PR with a brief, polite note referring back to the previous comment. The contributor can reopen at any time.

GitHub has no native auto-close — track these manually (calendar reminder, scheduled task, or a weekly maintainer sweep over open PRs with stale comments).

#### If the contributor responds with a stronger argument

Update your position openly. If a credible counterargument arrives, acknowledge it and adjust (merge as-is, bundle differently). Name the change explicitly in your next comment ("you're right that X — happy to keep both in this PR") so the trail is legible to anyone reviewing the discussion later.

If you find yourself rejecting every counterargument regardless of merit, you should have used [Path E](#path-e--close-and-replace) — and the contributor's time was wasted in the back-and-forth.

### Path E — Close and Replace

Use when the audit reveals the PR's shape needs to change — different mechanism than the established pattern, scope expanded beyond what the contributor can reasonably reach (e.g. frontend changes on a backend-only PR), or knock-on consequences that can't be fixed by stacking commits.

#### Iterate vs close-and-replace

| Iterate on branch ([Path B](#path-b--iterate-on-the-branch)) | Close and replace (Path E) |
|---|---|
| Same shape, small additions / fixes | Different mechanism from the established pattern |
| Scope unchanged | Scope expanded into different files/areas the contributor can't easily test |
| Contributor has bandwidth and is engaged | You'd be rewriting most of the diff yourself |
| One review round resolves it | You've already changed your mind once after asking them to validate |

If you've already asked the contributor to validate and you're now reconsidering the approach, **stop and re-audit first** — don't ask for a second validation round on a direction you're not confident in.

#### Closing comment

The contributor identified a real gap; you're reshaping the fix, not rejecting the intent. The comment must include:

- **Apology if you changed your mind** after the contributor already validated. Own the reversal explicitly; don't frame it as if the new pattern was always obvious.
- **Why** the shape needs to change, with file/line references — auditable, not opinion. If there are two or more distinct reasons, number them `### 1.`, `### 2.` inside a `## Why I'm closing` section so the contributor can refer to each individually.
- **What you'll do instead** — branch name (per [CONTRIBUTING.md → Branch Naming](./CONTRIBUTING.md#branch-naming)), scope, and confirmation that you'll credit the contributor in the replacement PR. Use a numbered list when the replacement spans multiple surfaces (backend + frontend + tests).

Choose the body shape based on substance — see [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections).

**Short close — single reason, narrow scope.** Prose throughout.

```markdown
Thanks for spotting this gap @contributor — and I owe you an apology: I asked you to validate the earlier shape before I'd finished the audit, and now I'm reversing course on you. That's on me, not on the work you did here.

Re-reading the codebase, `<the concern this PR addresses>` is already handled at `<the established pattern's location — file:line anchors>` rather than `<where this PR put the fix>`, and rebuilding on this PR's shape would mean rewriting most of the diff after we converge. So I'd rather close this as administrative housekeeping than ask you for another round.

I'll open `fix/<scope>-<short-description>` in the next day or two with `Co-authored-by:` crediting you — your instinct on the original gap is what makes the replacement possible, and that earns the attribution regardless of whose lines end up in the file. Reopen here anytime if it turns out `<the alternative shape>` makes sense after all.
```

**Substantive close — multiple reasons, multi-surface replacement.** Section the close into `## Why I'm closing` (with `### 1.` / `### 2.`) and `## What I'm doing instead` (numbered list of work items).

```markdown
Hi @contributor, my apologies — I've changed my mind after a deeper look at the diff together with `<the surrounding code or UI you re-audited>`. Thanks for running the end-to-end validation I asked for earlier; that part was done correctly. Closing this PR (not asking for changes) because the **scope and pattern** need to shift, and it's cleaner to land a fresh PR than to retrofit this one.

## Why I'm closing

`<Brief intro — "Two issues:", "Three reasons:", etc.>`

### 1. <One-line title naming the first issue>

<Prose explanation with file:line anchors. If the issue has sub-points that share the same root cause, enumerate them inline as bullets — for example, distinct routes or surfaces affected by the same over-restriction.>

- `<sub-point 1>` — <why it matters>.
- `<sub-point 2>` — <why it matters>.

<Closing sentence that references the established pattern this PR diverges from, with file:line anchors so the contributor can see where the consistent shape already lives.>

### 2. <One-line title naming the second issue>

<Prose explanation. If the issue spans multiple surfaces — backend + frontend, server + client — name each one with file:line anchors so the contributor knows the full scope.>

## What I'm doing instead

I'll open `fix/<scope>-<short-description>` in the next day or two with `Co-authored-by:` crediting you. Scope:

1. **<Surface 1, e.g. "Backend">** — <what changes and how it aligns with the established pattern>.
2. **<Surface 2, e.g. "Frontend — <specific area>">** — <what changes>.
3. **<Surface 3, if applicable>** — <what changes and any guard/visibility rule>.

Sorry again for the back-and-forth — the right pattern only became obvious to me on the second review. The security intent of your PR was correct; we just need a different shape for the fix.
```

#### Attribution in the replacement PR

The contributor must still get credit for spotting the issue, even if no line of their code survives in the replacement.

In the replacement PR description, under `## Notes` or `## Related`:

```markdown
Builds on #NNN by @contributor, reshaped after review to <one-sentence reason>.
```

This creates two-way cross-links: the closed PR shows "Referenced in PR #MMM", and the new PR shows the original as context.

At squash-merge time, add a `Co-authored-by:` trailer to the squash commit body — below the body prose, separated by one blank line. See [`Co-authored-by` Trailer Format](#co-authored-by-trailer-format) for the strict format.

### Path F — Close as Not Actionable

Use when the audit reveals the PR's premise doesn't hold — the bug it claims to fix isn't reachable, the behavior it changes is intentional, the threat it hardens against doesn't apply, or the proposed fix would introduce more regressions than it closes — *and* there is no underlying issue worth chasing in a replacement PR. This is the close path of last resort: no merge, no iterate, no reshape.

#### Path F vs Path D vs Path E

The three close-leaning paths differ on **confidence** and **whether a replacement is warranted**:

| | [Path D — Comment and Wait](#path-d--comment-and-wait) | [Path E — Close and Replace](#path-e--close-and-replace) | Path F — Close as Not Actionable |
|---|---|---|---|
| Maintainer confidence | "I might be wrong — what would change my mind?" | "I'm confident; the original gap is real but the shape needs to change" | "I'm confident; the original gap isn't real (or isn't worth closing)" |
| Audit depth at decision time | Partial — concerns raised, contributor input may flip position | Complete — established pattern named, replacement scope scoped | Complete — premise walked end-to-end, file:line evidence in hand |
| PR stays open during discussion? | Yes (with deadline + auto-stale) | No — closed immediately, replacement PR opens | No — closed immediately, no follow-up work |
| Replacement work? | None (yet) | Yes — new branch, `Co-authored-by:` credit | None |
| Reopen criterion | Contributor addresses concerns | Contributor brings a counter-pattern argument | Contributor brings concrete evidence the premise *does* hold (code path, deployment scenario, threat model) |

**The Path D → Path F failure mode:** keeping a PR open under Path D with no articulable "what would change my mind" — i.e. you've already decided but you're using a softer path. This wastes the contributor's time. If you've completed the audit and the premise doesn't hold, close under Path F now; don't let a deadline-driven Path D drift into closure-by-silence.

**The Path E → Path F failure mode:** opening a replacement PR you have no intention of actually shipping, just to soften the close. The contributor sees a stale branch with their name on it and reads the gesture for what it is. If you're not going to do the replacement work, use Path F honestly.

#### Common situations

This list is illustrative, not exhaustive. Use the audit, not pattern-matching against examples.

1. **False-positive bug report.** PR claims to fix a race condition / null deref / leak that the audit shows can't reach the runtime path the PR modifies — usually because an upstream guard, type system invariant, or framework lifecycle already covers it.
2. **Intentional behavior.** PR "fixes" a behavior that was deliberately designed that way, often with a load-bearing comment or test the contributor missed. Surface the original decision (`git blame`, the relevant test) in the close comment.
3. **Misidentified threat model on a security PR.** PR hardens a route against an attacker class that doesn't have access to the precondition the attack requires — e.g. CSRF guard on a route already protected by `SameSite=Strict` cookies plus origin check, or auth check on a route already behind the project-membership middleware. Cite the existing guard with file:line.
4. **Solution worse than the problem.** Even if the issue exists, the proposed fix introduces regressions whose blast radius exceeds the closed vector, *and* you don't have a cleaner alternative to suggest. Stating "no cleaner fix exists" is itself a position you should be able to defend — don't reach for Path F when you haven't done the alternative-shapes audit.
5. **Conflicts with explicit project direction.** PR adds a feature, dependency, or pattern the project has decided against (link the decision: PR comment, CONTRIBUTING.md section, design doc). Refusing on direction grounds is legitimate but rare on a small project — most genuine direction conflicts should be caught upstream of a PR existing.

#### Closing comment shape

Path F comments have a higher accountability bar than the other paths because the contributor's work doesn't land *and* nothing replaces it. The comment must include:

- **A warm, specific opener** — name the instinct, the careful writeup, the test scaffolding, whatever they did well. Generic "thanks for the PR" reads as filler; in a Path F close it reads as a brush-off.
- **The premise the PR rests on**, stated as the contributor would state it. Showing them you understood the intent is the precondition for the close landing as auditable rather than dismissive.
- **The audit-grounded reason the premise doesn't hold**, with file:line anchors to whatever invariant / existing guard / framework behavior makes the change unnecessary. *Auditable, not opinion.* If you can't anchor it, you haven't finished the audit — go back to Path D.
- **What would change your mind** — the concrete evidence (a code path you might have missed, a deployment scenario that changes the calculus, a repro the audit couldn't produce) that would justify reopening. This is the same persuadability standard as Path D; it just lives in a closed PR.
- **An explicit reopen invitation.** *"Reopen here anytime if `<the evidence>` shows up — I'd rather walk through it together than close the door."* Closure must read as administrative, not adversarial — per [Guiding Principles](#guiding-principles).

No deadline, no auto-stale — the PR is already closed at comment time, so there's nothing to wait for.

Choose the body shape based on substance — see [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections). A single premise failure is prose. Multiple distinct premise failures (rare — usually a sign you should re-audit, since one of them is probably the real story) get `### 1.` / `### 2.` inside a `## Why I'm closing` section.

**Single-premise example — prose throughout.**

```markdown
Hi @contributor, thanks for digging into this — `<the specific thing they did well: the threat model in the description, the test scaffolding, the audit instinct>` made the audit easy. Going to close this one, but I want to walk through why so it doesn't read as a brush-off.

The premise is `<one-sentence restatement of the bug the PR claims to fix, in the contributor's framing>`. Re-reading `path/to/file.ts:LL` together with `path/to/guard.ts:LL`, that case can't reach the runtime — `<the invariant / existing guard / framework behavior that makes it unreachable, with the specific lines that establish it>`. The patched check at `path/to/pr-file.ts:LL` would fire for inputs that the upstream guard has already rejected, so the net effect is dead code on the hot path.

What would change my mind: `<the concrete evidence — a request shape that bypasses the upstream guard, a deployment topology where the guard isn't in the path, a repro that produces the symptom on \`main\`>`. Reopen here anytime if any of that surfaces — I'd rather walk through it together than close the door.
```

**Multi-premise example — section per failure.** Use sparingly; if you find yourself writing more than two `### N.` blocks, re-audit before posting — Path F over-applied corrodes contributor trust.

```markdown
Hi @contributor, my apologies for the long read on this one — `<the specific thing they did well>` deserved a careful response, and I want to walk through why I'm closing rather than asking for changes.

## Why I'm closing

`<Brief intro: "Two reasons:", "The premise rests on two claims, neither of which holds:", etc.>`

### 1. <One-line title naming the first premise failure>

<Prose explanation with file:line anchors. Restate the contributor's claim in their framing, then walk the audit evidence that shows it doesn't hold.>

### 2. <One-line title naming the second premise failure>

<Same shape. If the two failures are independent, treat them separately; if they share a root cause, say so explicitly — that's usually a sign the audit should reframe to one premise, not two.>

## What would change my mind

- <Concrete evidence type 1 — code path, deployment scenario, threat model component>.
- <Concrete evidence type 2>.

Reopen here anytime if any of that surfaces. The instinct on `<the original observation that prompted the PR>` is still appreciated — it's how I'd want a contributor to flag something even when the eventual answer is "this doesn't reach the runtime."
```

#### When Path F is the wrong call

Re-route to a different path if any of these apply:

- **You're closing because the PR is small and you don't want to deal with it.** That's [Path B](#path-b--iterate-on-the-branch) territory — push the fix yourself and credit the contributor.
- **You're closing because the PR is large and you don't want to deal with it.** That's [Path D](#path-d--comment-and-wait) territory if the issue is real, or [Path E](#path-e--close-and-replace) if you'll actually do the replacement. Volume of work is not a Path F reason.
- **You haven't completed the audit but you have a strong prior.** Strong priors flip in audits — that's what audits are for. Finish the audit; if the prior holds, you'll have file:line anchors to cite, which is exactly what Path F requires.
- **The PR is security-shaped and the threat model is *partly* plausible.** Partial plausibility is Path D, not Path F. Security PRs closed under Path F need an explicit walk of the threat model against the diff, line by line — see [Security PRs](#security-prs) for the bar.

---

## Security PRs

Extra discipline applies on top of the standard lifecycle:

- **Audit adjacent code.** IDOR-style bugs, privilege-escalation patterns, and input-validation gaps usually cluster. If one site needed the fix, search the codebase for the same shape elsewhere before merging.
- **Audit frontend visibility** when restricting a backend route. The same route is typically reached from many UI surfaces — open polling, status badges, navigation entry points, deep-linked modals, auto-mounted stores — any of which will surface an unexpected authorization error to users who previously had access. Test the gated route end-to-end from the perspective of the now-restricted role (full UI walkthrough, not just the API/WS call), not just from the perspective of a role that still has access. This is a recurring regression class on any authorization change.
- **Prefer established patterns.** The codebase has settled patterns for different authorization classes — explicit allowlists for global/system mutations, per-resource access helpers for user-owned resources, default-open for benign reads. A new security PR should fit one of these existing classes; if a contributor introduces a new mechanism, ask why the established pattern doesn't cover the case before adopting the new shape.
- **Match the defense to the threat.** A textbook-correct hardening pattern can still be wrong for the specific code path it's applied to — what's being compared, what an attacker can actually steer, and what the new code costs on the hot path all matter. Ask the contributor for an explicit threat model before merging, especially when the fix replaces an indexed lookup with a scan or otherwise trades performance for hardening.
- **Surface DB-layer bypasses** in the PR comment even when fixed (e.g. implicit grants from upsert/ignore patterns, missing transaction boundaries, ORM defaults that skip validation).
- **Require a threat model** in `## Security impact`: who is the attacker, what can they reach now, what is closed by this PR.
- **Require a regression test.** Per [Audit step 3](#2-audit), security PRs without a `*.test.ts` covering the closed vector are not merge-ready.
- **Scope discipline.** If the audit finds out-of-scope issues, take the [Path C — Merge As-Is, Follow-up PR](#path-c--merge-as-is-follow-up-pr) route rather than letting the original PR balloon.
- **No public CVE-style disclosure** in the PR description until the fix has shipped to a release. Use neutral framing (*"hardens authorization checks"*) instead of attack details.

---

## Communication Norms

Cross-cutting rules that apply across all review paths.

- **Write all PR-facing text in English.** Review comments, suggested PR comments, suggested commit messages, suggested branch names, and anything else that lands on the PR page or in repo history must be in English — even when the maintainer-to-maintainer conversation (or maintainer-to-assistant conversation) is in another language. This applies symmetrically: if a contributor writes in another language, respond in English while keeping the tone warm. Per [CONTRIBUTING.md → Submitting Changes](./CONTRIBUTING.md#submitting-changes), the same rule applies to contributors.
- **Post review comments via the GitHub PR UI**, not `gh pr comment`. Markdown previews and `@mention` notifications behave differently between the two — the CLI path silently drops or mangles formatting that the UI gets right. **Exception:** when execution is delegated to an AI assistant under [Suggest by Default; Act on Confirmation](#suggest-by-default-act-on-confirmation), the assistant uses `gh pr comment <PR-NUMBER> --body-file <path>` because passing a file preserves the markdown the assistant drafted; the maintainer then verifies rendering on the PR page.
- **Match comment shape and length to substance.** A two-line concern is a two-line prose comment; a multi-class review (blockers + minor + please-add) gets `## Topic` sections so reviewers can scan; a substantial Path B follow-up or Path E close gets full PR-description shape. See [Comment Shape: Prose vs Sections](#comment-shape-prose-vs-sections) for the full pattern. Either way, open with one or two sentences naming something specific the contributor did well — generic "thanks for the PR" reads as filler; named appreciation lands. End with the next step or deadline when one is needed. Skip restated context and "I want to merge this, but..." padding.
- **Use file:line references** when describing technical issues. The diff is the source of truth; pointing to it makes the comment auditable. Anchor them inside sentences in prose ("at `path/to/file.ts:LL`, X happens — is there a reason..."), or in the body of a `### N.` sub-issue under a topic section — not as the start of unrelated bolded list items.
- **Resolve conflicts locally**, not in the GitHub web UI. Web-resolved merges drop signing and bypass local checks.
- **Never use `--no-verify`** or otherwise skip pre-commit hooks. If a hook fails, fix the underlying issue.
- **Don't link MAINTAINERS.md from PR comments.** This file is internal — external contributors can't act on its conventions, and linking it leaks process they aren't expected to follow. Reference [CONTRIBUTING.md](./CONTRIBUTING.md) (contributor-facing equivalent: `## Security impact` template, `After You Submit` for auto-stale window, etc.) or inline the policy in one sentence.

### Comment Shape: Prose vs Sections

A PR comment's form should match its substance. Three patterns, picked by what the comment is doing:

**Prose** — one or two short paragraphs, no `##` section headers. Use for:

- Path A approval (thanks + verification + merging).
- Path D with a single concern in a single class (one regression, one design question, one missing piece).
- Path C "merge as-is, follow-up incoming" notice.
- Short reply, counter, or clarification.
- Most contributor replies — agreeing with the audit, conceding a point, asking one follow-up question.

**Topic sections** (`## <Topic Name>`) — use when:

- The comment covers two or more distinct concern classes: `## Blockers`, `## Minor`, `## Please add to the PR description`, `## Note on tooling`, `## Regression`, etc. Each class gets its own `##` section so a reviewer skimming the PR knows where to look first.
- Inside a section, when there are multiple sub-issues, number them with `### 1.`, `### 2.`, each with a one-line title that names the issue (`### 1. \`bun run check\` fails at \`path/to/file.ts:LL\``). The title is the landing spot; the body is the explanation.

**PR-description shape** (`## Summary / ## Why / ## Changes / ## Security impact / ## Notes`, or `## Why I'm closing / ## What I'm doing instead`) — use when:

- Path B post-push summary documents substantive multi-file additions. Mirror the PR-description shape so reviewers can scan what's now in the branch.
- Path E close-and-replace lays out reasoning + replacement plan. `## Why I'm closing` (with `### 1.` / `### 2.` for multiple reasons) and `## What I'm doing instead` (numbered list when multi-surface).

This is the canonical exception to "section headers belong in PR descriptions" — when the comment itself documents a substantial set of changes or a structural decision, the same scannable shape is the right one.

**Either way:**

- Open with one or two sentences that name something specific the contributor did well. Sections never replace the opener; they sit *after* it.
- One issue per paragraph inside a section. File:line references inline in prose (`at \`path/to/file.ts:LL\`, X happens — is there a reason...`), not as the start of bolded list items.
- Code blocks for repros, failure messages, before/after snippets where they help — but only when they help. A two-line error message inline reads cleaner than the same message wrapped in fences.
- Skip restated context the contributor already knows. Skip "I want to merge this, but..." framing. Skip numbered audit-verdict lists with bolded leads (`**1. Issue:** ...`) — they read as a checklist handed down, not a conversation.

**When in doubt,** ask whether a reviewer skimming the comment would benefit from labeled landing spots. If the body is short enough to read end-to-end, prose. If it has two or more distinct classes of concern, sections. If you're documenting substantive work or a structural close, PR-description shape.

### Suggest by Default; Act on Confirmation

When you're contributing review work to a PR you are **not** personally merging — AI assistants, sub-reviewers doing first-pass triage, anyone whose output the merging maintainer will adopt — the audit response always ships with exactly two artifacts:

1. **A suggested commit message** — subject and body — following [CONTRIBUTING.md → Commit Messages](./CONTRIBUTING.md#commit-messages). If a branch name needs to be proposed, follow [CONTRIBUTING.md → Branch Naming](./CONTRIBUTING.md#branch-naming) exactly. Comment-only paths ([Path D — *Comment and Wait*](#path-d--comment-and-wait) and [Path F — *Close as Not Actionable*](#path-f--close-as-not-actionable)) have no maintainer commit, so omit this artifact. For Path D, note that the existing PR title will serve as the squash subject if the contributor's revisions land. For Path F, there is no squash subject because the PR is being closed.
2. **A suggested PR comment** matching the chosen review path — start from the worked example in the relevant subsection of [Review Paths](#review-paths) and adapt to the actual diff.

**Draft these inline with the audit; never ask permission to draft.** "Should I draft a comment?" is the wrong question — the artifacts are part of the deliverable, not a follow-up offer. Confirmation gates exist only for *acting* on the suggestion (Stage 1: editing the working tree; Stage 2: committing, pushing, posting). A draft that lives only in chat hasn't touched the repo and doesn't need a gate.

The merging maintainer is the one who clicks "Squash and merge" on GitHub. Do not chain a meta-PR proposal (branch + commit + PR description) onto your own analysis output — that's the maintainer's call to make, not yours to script. If your work itself touches docs or code, leave the working tree in the right state and stop there. If the maintainer wants help drafting the commit message and PR comment for *that* change, they'll ask.

This separation keeps audit accountability with the person who has merge rights, and prevents an upstream assistant's read of the diff from being rubber-stamped through the merge step.

#### Two-stage execution (when the maintainer delegates)

If the maintainer wants the assistant to carry the suggestion through to the PR, the assistant must ask for explicit confirmation at **two** points. Each stage is a separate yes — a "yes" at stage 1 is **not** consent for stage 2. For comment-only paths — [Path D](#path-d--comment-and-wait) (open + comment + wait) and [Path F](#path-f--close-as-not-actionable) (close + comment + no follow-up) — where the deliverable is the PR comment alone with no code changes, Stage 1 doesn't apply; skip directly to Stage 2. For Path F, Stage 2 also includes `gh pr close <PR-NUMBER>` after the comment posts so the close and the reasoning land in the same maintainer action.

**Stage 1 — Apply the fix.**
After presenting the audit findings, ask: *"Should I apply the fix to the working tree?"*
- If **yes**: edit files, then run `bun run check` and `bun run lint`. Stop after verification and report the working-tree state. Do not stage, commit, or push yet.
- If **no**: stop. The maintainer will apply it themselves.

**Stage 2 — Commit, push, and post the PR comment.**
After Stage 1 lands and verifications are green, ask: *"Should I commit, push, and post the PR comment to #NNN?"* Include the proposed commit message and the PR comment markdown inline in the question so the maintainer is approving the exact text.
- If **yes**: write the drafted PR comment to a temp markdown file (e.g. `/tmp/pr-NNN-comment.md`), then run the sequence below using the maintainer's existing git/gh credentials:
  ```bash
  git add <specific files, never -A unless explicitly requested>
  git commit -m "<type>(<scope>): <subject>"
  git push
  gh pr comment <PR-NUMBER> --body-file /tmp/pr-NNN-comment.md
  ```
  Then report back with the pushed commit SHA and the comment URL so the maintainer can verify rendering on the PR page and click "Squash and merge".
- If **no**: stop. The maintainer will run the steps manually.

#### Constraints on Stage 2

- **Use the maintainer's existing credentials.** Do not run `git config user.name` / `user.email`, do not pass `-c user.email=...`, do not set `GIT_AUTHOR_*` env vars. Whatever the maintainer's local git is configured to do is what gets committed.
- **Never `--no-verify` or `--no-gpg-sign`.** If a pre-commit hook fails, fix the underlying issue and create a new commit — never amend the pre-hook state away.
- **Never force-push** under this protocol. If push is rejected because the contributor's fork moved, stop and surface the conflict to the maintainer; do not `--force` or `--force-with-lease`.
- **Never run `git merge` or the GitHub squash-merge** as part of Stage 2. The final merge button is the maintainer's, always.
- **Stage files explicitly by name** — do not `git add -A` or `git add .` unless the maintainer asked for it. Adjacent uncommitted work from the maintainer's session must not be swept into the PR commit.
- **Use `--body-file`, not `--body`,** for `gh pr comment`. This is the only sanctioned use of `gh pr comment` (see the exception under [Communication Norms](#communication-norms)) and only because passing a file preserves the markdown verbatim.
- **Verify rendering.** After posting, report the comment URL so the maintainer can open it on the PR page and confirm formatting, mentions, and code blocks rendered correctly. If rendering looks wrong, the maintainer edits via the GitHub UI — the assistant does not delete and repost.

#### When NOT to ask for Stage 2

Some situations require maintainer hands on the keyboard. In these cases, deliver only the two default artifacts and stop — do **not** offer to execute, even if the maintainer typically delegates.

- The audit is incomplete (adjacent code or adjacent patterns not yet checked).
- The PR is security-sensitive and the threat model in `## Security impact` has not been reviewed end-to-end against the diff.
- Stage 2 would require a force-push to land (rebase resolution, history rewrite).
- The PR targets `main` directly rather than going through squash-merge via the UI.
- The maintainer has not explicitly opted in this session. Silence is not consent.

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

Used in squash-commit bodies when attributing a contributor whose PR was closed and reshaped (see [Path E — Close and Replace](#path-e--close-and-replace)). Format is strict — GitHub silently drops malformed trailers.

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

### Publishing the Memory Graph Embedding Artifact

Memory's semantic recall runs on a local embedding table — four files, ~44 MB, hosted as a **GitHub release asset**, not shipped in the repository and not published to npm. They are weights, not code: bundling them would add 44 MB to every install whether or not memory is enabled, and publishing to npm would mean publishing a package this repository is itself the source of.

Clopen downloads them on demand into `~/.clopen/stack/embedding/<version>/`. Until they land, **recall is off** — recording continues, and the indexer backfills vectors when the artifact arrives, so nothing recorded during setup is lost.

Where things live:

| Path | Role | In git? |
| --- | --- | --- |
| `packages/clopen-embedding/model/` | Build output, staged for upload | No — gitignored |
| `packages/clopen-embedding/checksums.json` | Emitted by the build script | No — gitignored |
| `backend/memory/embedding/paths.ts` | `EMBEDDING_VERSION` + pinned checksums | **Yes** |
| GitHub release `embedding-v<version>` | What users download | n/a |

#### Publishing a version whose checksums are already pinned

If `paths.ts` already carries real checksums for the current `EMBEDDING_VERSION`, the artifact was built and just needs uploading. Verify the local files still match the pins before you publish — a mismatch means the release will fail verification on every user's machine:

```bash
cd packages/clopen-embedding/model
shasum -a 256 model.bin tokenizer.json tokenizer_config.json manifest.json
# Compare against EMBEDDING_ASSETS in backend/memory/embedding/paths.ts
```

Then:

```bash
gh release create embedding-v0.0.1 \
  packages/clopen-embedding/model/model.bin \
  packages/clopen-embedding/model/tokenizer.json \
  packages/clopen-embedding/model/tokenizer_config.json \
  packages/clopen-embedding/model/manifest.json \
  --repo myrialabs/clopen \
  --title "Memory Graph embedding artifact v0.0.1" \
  --notes "Pruned int8 Model2Vec table (potion-multilingual-128M, MIT). Downloaded on demand by the Memory Graph; not an npm package."
```

Three things break the download silently if changed:

- **The tag** must be exactly `embedding-v<EMBEDDING_VERSION>`.
- **The asset filenames** must stay as they are — `assetUrl()` builds the URL from the filename.
- **The release must be public.** `install.ts` fetches unauthenticated; a draft or private release gives every user a 404 that retries forever.

#### Shipping a NEW model version

Rebuilding is a coordinated change: the checksums in `paths.ts` and the files on the release must move together, in that order, or users get a verification failure they cannot fix.

1. **Build.** `--install` also drops it into the local stack so you can try it before anyone else does:

   ```bash
   bun scripts/build-embedding-artifact.ts --install
   ```

   The script prints an `EMBEDDING_ASSETS` block and writes `checksums.json`.

2. **Bump `EMBEDDING_VERSION`** in `backend/memory/embedding/paths.ts`. Always bump — the install directory is version-keyed, so reusing a version means existing users keep the old files forever and never see the new ones.

3. **Paste the new `EMBEDDING_ASSETS` block** into the same file, in the same commit as the bump. A version bumped without its checksums makes `hasPinnedChecksums()` false and the installer refuses to download — which fails safe, but leaves recall off for everyone until it is corrected.

4. **Verify locally before publishing.** Delete the installed copy and let the app fetch it, which is the only way to exercise the real download path:

   ```bash
   rm -rf ~/.clopen/stack/embedding/<new-version>
   ```

   Restart, then check Settings → Memory reports the model as ready. Note that a machine which has ever run `--install` will pass a "is it ready" check without proving the release works.

5. **Publish the release** with the new tag, using the command above.

6. **Merge the version bump only once the release is live.** In the other order, every user who updates between the two lands on a build whose pinned checksums point at a tag that does not exist yet.

If a published artifact turns out to be wrong, do **not** replace the assets on an existing tag — clients cache by version directory and checksum-verify, so a swapped file reads as corruption. Cut a new version instead.

### Questions

Internal team: use the team Slack/Discord channel.
