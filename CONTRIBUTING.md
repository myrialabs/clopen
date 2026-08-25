# Contributing Guide

Thanks for considering a contribution. This guide covers the development environment, code conventions, and the submission process — everything you need to open a PR.

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
  - [Keep Your Fork Updated](#keep-your-fork-updated)
  - [Development Data Directory](#development-data-directory)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
  - [TypeScript](#typescript)
  - [Svelte 5](#svelte-5)
  - [Naming](#naming)
  - [Logging](#logging)
  - [Formatting](#formatting)
  - [Tests](#tests)
- [Submitting Changes](#submitting-changes)
  - [Delivering a Change](#delivering-a-change)
  - [Branch Naming](#branch-naming)
  - [Commit Messages](#commit-messages)
  - [Before You Push](#before-you-push)
  - [Pull Request Format](#pull-request-format)
  - [Comments on Existing PRs](#comments-on-existing-prs)
- [After You Submit](#after-you-submit)
- [Reference](#reference)
  - [Commands](#commands)
  - [Troubleshooting](#troubleshooting)
  - [Resources](#resources)
- [Questions](#questions)

---

## Getting Started

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) v1.2.12+
- At least one supported AI engine:
  - [Claude Code](https://github.com/anthropics/claude-code) by Anthropic
  - [OpenCode](https://opencode.ai) by Anomaly
  - [Codex](https://github.com/openai/codex) by OpenAI
  - [GitHub Copilot CLI](https://github.com/github/copilot-cli) by GitHub
  - [Qwen Code](https://github.com/QwenLM/qwen-code) by Alibaba Qwen
  - [Pi](https://github.com/earendil-works/pi) by Earendil Works
  - [Cline](https://github.com/cline/cline) by Cline Bot Inc.
  - [Cursor](https://cursor.com) by Anysphere

Engines install on demand via **Settings → Stack** after first launch (into a clopen-managed directory, not your global setup).

Clopen is a Bun-only project — Node.js and Deno are not supported. Use `bun` for all package management and scripts.

### Setup

Fork the repository via the GitHub UI, then:

```bash
git clone https://github.com/YOUR_USERNAME/clopen.git
cd clopen
git remote add upstream https://github.com/myrialabs/clopen.git
bun install
bun run check
```

`bun run check` should pass cleanly on a fresh clone. If it doesn't, see [Troubleshooting](#troubleshooting).

### Keep Your Fork Updated

Before starting any new branch, sync with upstream:

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main   # optional: also sync your fork's main on GitHub
```

### Development Data Directory

Clopen resolves its data directory once at startup, from `NODE_ENV`:

| Context | Directory |
|---------|-----------|
| `bun run dev` | `~/.clopen-dev` |
| `bun run test` | `~/.clopen-test` |
| Installed release | `~/.clopen` |

`CLOPEN_DATA_DIR` overrides all three. The separation matters because Clopen is often used to develop itself — neither the dev server nor the test suite can reach the database of a running production instance. Don't reintroduce a code path that reads `NODE_ENV` to pick a directory; use `SERVER_ENV.DATA_DIR` (`backend/utils/env.ts`), which is resolved a single time so a dependency mutating `process.env` mid-run can't move state out from under the server.

---

## Development Workflow

Standard flow from branch creation to PR:

```bash
# 1. Sync
git checkout main && git pull upstream main

# 2. Branch
git checkout -b feature/your-feature

# 3. Develop & verify locally
bun run check && bun run lint && bun run test && bun run build

# 4. Commit — one commit, subject and body (see Delivering a Change)
git commit

# 5. Sync with upstream main again (resolve conflicts locally, not in the GitHub UI)
git fetch upstream && git merge upstream/main
bun run check && bun run lint && bun run test && bun run build   # re-verify after merge

# 6. Push & open PR
git push origin feature/your-feature
```

Open the PR targeting `main` on GitHub. See [Submitting Changes](#submitting-changes) for the conventions used at each step.

---

## Code Style

### TypeScript

- Use `const` by default; use `let` only when reassignment is needed.
- `any` is acceptable for Elysia/WS patterns where strict typing creates friction.

### Svelte 5

Use the runes system, not legacy stores. `let` for `$state` and `$bindable`; `const` for everything else (`$derived`, `$props`, functions).

```svelte
<script lang="ts">
  let count = $state(0);
  const doubled = $derived(count * 2);
  const handleClick = () => count++;
</script>
```

### Naming

- `camelCase` — variables, functions
- `PascalCase` — classes, types
- `UPPER_SNAKE_CASE` — constants
- `kebab-case` — file names

### Logging

Use the project's `debug` module instead of `console.*`. It respects log levels and namespaces.

```typescript
import { debug } from './utils/debug';

debug.log('namespace', 'message', { data });
```

### Formatting

Tabs, single quotes, semicolons. No Prettier enforcement — manual consistency.

### Tests

Add a `*.test.ts` file when the change introduces non-trivial logic where a regression would be silent or costly — validators, parsers, security checks, path resolution, anything with branching that isn't obvious by inspection. Place the test alongside the source: `foo.ts` → `foo.test.ts`. Use `bun:test`.

Skip tests for changes that are inherently observable (UI tweaks, log strings, dependency bumps), trivial one-liners, or thin forwards of an already-tested function. If breaking the code would take more than a glance to notice, add a test.

For security fixes, tests are expected — at minimum a case that fails before the patch and passes after. Cover the boundary explicitly (the exact value that should be rejected) and at least one happy path.

```bash
bun test path/to/file.test.ts   # single file, while iterating
bun run test                    # full suite — what CI runs
```

Use `bun run test` for the full suite, not bare `bun test`. The script adds `--isolate`, which is what keeps one test's global state out of the next one's.

CI runs the full suite on every PR, so it must pass whether or not your change touched a test file.

---

## Submitting Changes

All written content on the repository — branch names, commit messages, PR titles, PR descriptions, and PR comments — must be in **English**, regardless of the language you and the maintainers use elsewhere. This keeps the contribution trail readable across the project's audience.

### Delivering a Change

Once the work is done and verified, it is delivered as **one commit on one branch**. Decide all three pieces before you push:

1. **Branch name** — `<type>/<description>`, per [Branch Naming](#branch-naming).
2. **One commit** — subject *and* body, per [Commit Messages](#commit-messages). Squash your local work-in-progress into it rather than pushing a trail of "wip" and "fix typo" commits.
3. **PR description** — filled in from the template in [Pull Request Format](#pull-request-format), ready to paste when you open the PR. If the work extends a PR that's already open, post it as a comment following [Comments on Existing PRs](#comments-on-existing-prs) instead.

One commit is the delivery shape, not a rule against history. After the branch is pushed, address review feedback in **new commits on top** — don't amend or force-push a branch a maintainer is reading, since that detaches their review threads. The squash-merge collapses the follow-ups when the PR lands.

### Branch Naming

Format: `<type>/<description>` — lowercase, kebab-case, concise. **Exactly one `/`**: the type, then the description. Nested paths are not allowed.

| Type | Use |
|------|-----|
| `feature/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation |
| `chore/` | Build, refactor, dependencies, miscellaneous |

Examples: `feature/database-management`, `fix/websocket-connection`, `docs/maintainers-guide-restructure`.

**Don't**:

| Wrong | Why | Fix |
|------|-----|-----|
| `docs/maintainers/review-examples` | Two slashes — nested path | `docs/maintainers-review-examples` |
| `Fix/Websocket-Connection` | Uppercase | `fix/websocket-connection` |
| `fix/fix-the-websocket-connection-bug-that-happens-on-reconnect` | Verbose | `fix/websocket-reconnect` |
| `feature/auth.middleware` | Non-kebab punctuation | `feature/auth-middleware` |

### Commit Messages

Format: `<type>(<scope>): <subject>` — imperative mood, lowercase, no period.

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `refactor` | Restructuring with no behavior change |
| `perf` | Performance work |
| `chore` | Build, dependencies, tooling, miscellaneous |

The scope is the area the change lands in — `chat`, `terminal`, `engine`, `preview`, `settings`. Omit it when the change is genuinely repo-wide; don't invent one to fill the slot.

```
feat(chat): add message export
fix(terminal): resolve memory leak
refactor(engine): install engine SDKs on demand into a managed Stack dir
docs(maintainers): document pr reshape workflow
chore: update dependencies
```

Version-bump commits are the one exception: maintainers commit those as a bare version number (`0.4.28`), no type or scope. Contributors never write one.

**Length.** Aim for 72 characters and treat ~80 as the hard ceiling. Squash-merge appends ` (#NNN)` to the PR title, so a subject at the ceiling lands near 88 on `main` — that's the trade the repo already makes for subjects that stay specific. Trim by cutting words, not by going vague: `fix(settings): isolate test data dir` beats `fix(settings): fix settings bug` at any length.

Keep the subject focused on **why** the change exists, not what files moved.

#### Commit Body

Every non-trivial commit carries a body. Leave it off only when the subject is the whole story — a dependency bump, a version release, a one-line typo fix.

Separate it from the subject with a blank line and wrap at 72 columns. Write prose paragraphs, not bullets, covering three things in order:

1. **What was broken or missing** — the symptom as a user or reviewer would hit it.
2. **Why it happened** — the root cause, named precisely enough that someone could find it again.
3. **What the change does about it** — the mechanism, not a file list.

Describe the code, not your work on it: *"Undo used a bare `HEAD~1`, which cannot resolve on a root commit"*, not *"I rewrote the undo function"*. Skip anything the diff already says plainly. When a change spans several areas, give each its own paragraph behind a short label (`Watcher:`, `Switching:`, `Loaders:`).

```
fix(git): support undoing the root commit and guard empty repos

Undo used a bare `HEAD~1`, which cannot resolve on a root commit or an
unborn HEAD, so the Git panel surfaced git's raw "fatal: ambiguous
argument" instead of doing the undo. Undoing the root commit now deletes
the branch ref; the same probes translate the unborn-HEAD failures in
revert, amend, stash, push, and log.
```

The body and the PR description overlap by design. The body is the durable record on `main` — it's what someone reads years later while bisecting. The PR description adds the review-time layer on top: test plan, screenshots, follow-ups, anything that stops mattering once the PR is merged.

Recent commits on `main` are the reference. Run `git log` and read the last few before writing yours.

### Before You Push

CI (`.github/workflows/ci.yml`) runs these four on every PR, in this order. Run them locally first — a red PR costs a round trip:

```bash
bun run check   # type check
bun run lint    # eslint
bun run test    # full suite, --isolate
bun run build   # must produce dist/
```

Then check what CI can't:

- [ ] New non-trivial logic has a `*.test.ts` (see [Tests](#tests))
- [ ] Commit message follows the format above, with a body unless the subject is the whole story
- [ ] No `console.*` (use the `debug` module)
- [ ] No sensitive data (tokens, credentials, internal URLs) — including in test fixtures, where a real local path is a leak
- [ ] Nothing outside the change's scope crept into the diff

The repo ships no git hooks, so nothing stops you from pushing a failing commit; CI is the only gate and it runs after you've already asked for review. If you do have local hooks and one fails, fix the underlying issue rather than skipping with `--no-verify`.

### Pull Request Format

#### Title

Same format and length as the commit subject: `<type>(<scope>): <subject>`, lowercase, imperative, no period. Make it identical to your commit subject — GitHub uses the PR title, not the commit, as the squash subject on `main`, and appends ` (#NNN)` to it.

#### Description Template

```markdown
## Summary
One or two sentences: what this PR does.

## Why
The motivation — bug it fixes, behavior it changes, constraint it addresses.

## Changes
- bullet list of concrete changes (files, modules, behaviors)

## Notes (optional)
Anything reviewers should know: trade-offs, follow-ups, areas needing extra eyes.
```

#### Optional Sections

Add only when relevant — empty headers add noise:

| Section | When to use |
|---------|-------------|
| `## Test plan` | Any non-trivial change. Bulleted checklist of how the change was verified (`bun run check`, manual UI test, regression test, etc.). |
| `## Security impact` | Any change touching auth, authorization, input validation, file/path handling, or external execution. State the threat model in one paragraph: who is the attacker, what they could reach before, what is closed now. |
| `## Breaking changes` | Public API, WebSocket schema, DB schema, or config keys changed. Include migration path. |
| `## Migration` | Steps existing installs need to follow (DB migration, config update, manual cleanup). |
| `## Screenshots` | UI changes — before/after images or a short clip. |
| `## Follow-ups` | Known TODOs deferred to a separate PR (with link/issue if one exists). |
| `## Related` | Links to related issues, PRs, or external discussions. |

### Comments on Existing PRs

Match the comment's shape to its substance. Most contributor comments are short replies and read best as prose; a few situations warrant lists or topic sections so reviewers can scan.

The examples below are illustrative templates, not literal copy-paste — angle-bracket slots like `<the specific reasoning>` and concrete-looking names should be replaced with what's actually in your PR. Structural pieces (the opening "Thanks for…", the closing commitment, `## Header` shapes) are the lesson; keep those.

**Prose — the default.** Short replies, single-topic responses, agreements, clarifications. Open with one or two sentences that name something specific you took from the review (the catch, the file:line reference, the reasoning) — generic "thanks" is filler. Then raise your reply, concern, or counter in prose, anchored to file:line inline. Warmth and brevity are not opposites.

```markdown
Thanks for the careful breakdown. I re-validated the flow and I agree with your assessment: `<the specific point the maintainer made, in your own words>`. So `<the practical consequence — why the original fix shape doesn't apply, or what changes in your understanding>`.

I'm closing this PR to avoid carrying the wrong abstraction. If `<the condition that would make the original direction relevant>` changes in the future, I'll open a separate PR with `<the alternative approach — the layer it belongs at, the test that would pin it>`.
```

**Validation-result list.** When responding to a maintainer's "please verify end-to-end" request, a bulleted list of what you ran is appropriate — it's concrete evidence, not framing. Keep the items factual; one line each. Only include items you actually ran; if the maintainer didn't ask for a manual UI walkthrough, the universal commands alone are fine.

```markdown
Thanks for the guidance. I re-tested this PR locally after installing Bun.

Validation performed:
- `bun run check` passes with 0 errors / 0 warnings.
- `bun run lint` passes.
- Started the app locally with `bun run dev` and exercised <the specific flow the maintainer asked about>.

<Optional one-sentence summary tying the validation back to the maintainer's concern, if it isn't obvious from the items above.>
```

If the maintainer asked you to verify multiple distinct scenarios (e.g. a positive case and a negative case for an authorization change), add one bullet per scenario — each describing what you did and what you observed, not just "verified X". The bullets mirror what was actually asked; they aren't a fixed checklist.

**Topic sections** (`## <Topic Name>`) — use when:

- You pushed commits or expanded scope and the additions span multiple files/areas. Mirror the PR-description shape (`## Summary / ## Why / ## Changes / ## Notes`) so reviewers can scan what's new.
- Your reply addresses multiple distinct concerns the maintainer raised (e.g. a blocker + a process question + a follow-up commitment). One `##` per class, prose inside.

For everything else — single reply, agreement with the audit, clarification of one detail — prose is shorter and clearer.

**Either way:**

- File paths and identifiers in backticks.
- `@username` for mentions.
- Dates as plain English (`May 25, 2026`), not ISO format.
- One issue per paragraph. No restated context.
- Avoid numbered audit-verdict lists with bolded leads (`**1. Issue:** ...`) — they read as a checklist handed back, not a conversation.

---

## After You Submit

A maintainer will read the full diff and audit it before responding. You can expect one of these responses:

| Response | What it means |
|----------|---------------|
| Approve and merge | Audit was clean. |
| Commits added to your branch | Maintainer extended your fix with adjacent changes and posted a summary. Pull before pushing anything new. |
| Comment requesting discussion | Maintainer has concerns or wants to split scope. Default response window is 1 week — silence past the deadline closes the PR as auto-stale, and you can reopen at any time. |
| Close with reshape | Approach needs to change. You'll be credited in the replacement PR — closure is administrative, not rejection. |

If you disagree with feedback, push back with a concrete scenario, file/line reference, or counterargument — reviewers expect this and will update their position when warranted.

---

## Reference

### Commands

```bash
bun run dev          # Dev server (data in ~/.clopen-dev)
bun run check        # Type check
bun run lint         # Lint
bun run lint:fix     # Auto-fix lint
bun run test         # Full test suite (data in ~/.clopen-test)
bun run build        # Build to dist/
bun run start        # Serve a built dist/
```

### Troubleshooting

```bash
# Type errors
rm -rf node_modules && bun install

# Lint errors
bun run lint:fix

# Conflicts with upstream — merge, don't rebase: rebasing rewrites the
# commit hashes a reviewer is already reading, and landing it needs a
# force-push, which detaches their review threads.
git fetch upstream && git merge upstream/main
```

### Resources

- [TypeScript Docs](https://www.typescriptlang.org/docs/)
- [Svelte 5 Docs](https://svelte.dev/docs/svelte/overview)
- [Bun Docs](https://bun.sh/docs)
- [Elysia Docs](https://elysiajs.com/)
- [Conventional Commits](https://www.conventionalcommits.org/)

---

## Questions?

- [Issues](https://github.com/myrialabs/clopen/issues)
- [Discussions](https://github.com/myrialabs/clopen/discussions)
