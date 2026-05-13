# Contributing Guide

Thanks for considering a contribution. This guide covers the development environment, code conventions, and the submission process. For the maintainer side (review paths, attribution, merge conventions), see [MAINTAINERS.md](./MAINTAINERS.md).

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
- [Submitting Changes](#submitting-changes)
  - [Branch Naming](#branch-naming)
  - [Commit Messages](#commit-messages)
  - [Pre-commit Checklist](#pre-commit-checklist)
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

Engines can be installed manually or via **Settings → System Tools** after first launch.

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

When running `bun run dev`, Clopen stores data in `~/.clopen-dev` instead of `~/.clopen`. This keeps development data separate from any production instance — especially important since Clopen can be used to develop itself.

---

## Development Workflow

Standard flow from branch creation to PR:

```bash
# 1. Sync
git checkout main && git pull upstream main

# 2. Branch
git checkout -b feature/your-feature

# 3. Develop & verify locally
bun run check && bun run lint && bun run build

# 4. Commit
git commit -m "feat(scope): description"

# 5. Sync with upstream main again (resolve conflicts locally, not in the GitHub UI)
git fetch upstream && git merge upstream/main
bun run check && bun run lint && bun run build   # re-verify after merge

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

---

## Submitting Changes

### Branch Naming

Format: `<type>/<description>` — lowercase, kebab-case, concise.

| Type | Use |
|------|-----|
| `feature/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation |
| `chore/` | Build, refactor, dependencies, miscellaneous |

Examples: `feature/database-management`, `fix/websocket-connection`, `docs/maintainers-guide-restructure`.

### Commit Messages

Format: `<type>(<scope>): <subject>` — imperative mood, lowercase, no period, max 72 characters.

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `chore` | Refactor, build, perf, dependencies |
| `release` | Version release |

Examples:

```
feat(chat): add message export
fix(terminal): resolve memory leak
docs(maintainers): document pr reshape workflow
chore: update dependencies
```

Keep the subject focused on **why** the change exists, not what files moved. If the change needs a longer explanation, put it in the PR description, not the commit body — repo convention is subject-only.

### Pre-commit Checklist

Before pushing each commit:

- [ ] `bun run check` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` works
- [ ] Commit message follows the format above
- [ ] No `console.*` (use the `debug` module)
- [ ] No sensitive data (tokens, credentials, internal URLs)

If a pre-commit hook fails, fix the underlying issue rather than skipping with `--no-verify`. Hooks exist for the same reasons CI does.

### Pull Request Format

#### Title

Same format as commit messages: `<type>(<scope>): <subject>` (lowercase, imperative, no period, ≤72 chars). GitHub uses this as the squash-commit subject on `main`.

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

When you add substantive context to a PR (additional commits, scope expansion, a regression caught in review), use the same `## Summary / ## Why / ## Changes / ## Notes` structure. Keep paths and identifiers in backticks. Use `@username` for mentions.

---

## After You Submit

Once your PR is open, a maintainer will read the full diff and audit it before responding. The audit checks for adjacent gaps the PR didn't address (similar bugs nearby) and adjacent patterns (whether an established pattern in the codebase already covers the case). See [MAINTAINERS.md](./MAINTAINERS.md) for the maintainer side of the process.

You can expect one of four responses:

- **Approve and merge** — the audit was clean.
- **Commits added on your branch** — the maintainer extends your fix with adjacent changes and posts a summary comment. Pull the branch before pushing anything new.
- **Comment requesting discussion** — the maintainer has concerns, or sees a part that could be split into a separate PR. There's usually a 1-week response window. Silence past the deadline closes the PR as auto-stale (you can reopen at any time).
- **Close with reshape** — the approach needs to change in a way that's easier to start fresh. You'll be credited in the replacement PR. Closure is administrative, not rejection.

If you disagree with feedback, push back — provide a concrete scenario, file/line reference, or counterargument. The maintainer side of the doc explicitly invites this.

---

## Reference

### Commands

```bash
bun run dev          # Dev server
bun run check        # Type check
bun run lint         # Lint
bun run lint:fix     # Auto-fix lint
bun run build        # Build
```

### Troubleshooting

```bash
# Type errors
rm -rf node_modules && bun install

# Lint errors
bun run lint:fix

# Git conflicts
git fetch upstream && git rebase upstream/main
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
