# Contributing Guide

Contributing guide for Clopen. For maintainer instructions, see [MAINTAINER.md](logs/MAINTAINER.md).

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.2.12+
- [Git](https://git-scm.com/)
- [Claude Code](https://github.com/anthropics/claude-code)

### Setup

```bash
# Fork via GitHub UI, then:
git clone https://github.com/YOUR_USERNAME/clopen.git
cd clopen
git remote add upstream https://github.com/myrialabs/clopen.git

bun install
cp .env.example .env

# Verify
bun run check
bun run lint
bun run build

# Test
bun link
clopen
bun unlink
```

### Keep Updated

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

---

## Branch Naming

Format: `<type>/<description>`

| Type | Use |
|------|-----|
| `feature/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation |
| `chore/` | Other changes |

Rules:
- Lowercase only
- Use hyphens
- Short and descriptive

Examples:
```bash
feature/database-management
fix/websocket-connection
docs/update-readme
```

---

## Commit Messages

Format: `<type>(<scope>): <subject>`

### Types

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `chore` | Other (refactor, test, build, perf) |
| `release` | Version release |

### Scopes

Common: `chat`, `terminal`, `preview`, `files`, `db`, `api`, `ui`, `deps`

### Rules

- Imperative mood ("add" not "added")
- No capital first letter
- No period at end
- Max 72 characters

### Examples

```bash
feat: add database management UI
feat(chat): add message export
fix(terminal): resolve memory leak
docs: update installation guide
chore: update dependencies
chore(preview): optimize streaming
release: v0.1.0
```

---

## Development Workflow

### Step 1: Sync

```bash
git checkout main
git pull upstream main
git push origin main
```

### Step 2: Branch

```bash
git checkout -b feature/your-feature
```

### Step 3: Develop

```bash
# Make changes, then:
bun run check
bun run lint
bun run build
```

### Step 4: Commit

```bash
git add .
git commit -m "feat(scope): description"
```

### Step 5: Push

```bash
git push origin feature/your-feature
```

### Step 6: PR

Via GitHub UI:
1. Go to https://github.com/myrialabs/clopen/pulls
2. "New Pull Request" → "compare across forks"
3. base: `myrialabs/clopen` → `dev`
4. head: `YOUR_USERNAME/clopen` → `feature/your-feature`
5. Fill template & create

Via CLI:
```bash
gh pr create --base dev --title "feat: your feature"
```

### Step 7: Address Feedback

```bash
# Make changes
git add .
git commit -m "fix: address feedback"
git push
```

### Step 8: After Merge

```bash
git checkout main
git branch -D feature/your-feature
git pull upstream main
git push origin main
```

---

## Pre-commit Checklist

```bash
bun run check
bun run lint
bun run build
bun link && clopen
```

Verify:
- [ ] Code follows conventions
- [ ] Commit message follows format
- [ ] Branch name follows format
- [ ] No sensitive data
- [ ] No `console.*` (use `debug` module)

---

## Pull Request Guidelines

### Title Format

```
feat(scope): description
fix(scope): description
docs(scope): description
```

Examples:
- `feat(chat): add message export`
- `fix(terminal): resolve memory leak`

### PR Template

```markdown
## Summary
Brief description

## Type
- [ ] Bug fix
- [ ] Feature
- [ ] Breaking change
- [ ] Docs

## Changes
- Added/Fixed/Updated...

## Testing
- [ ] `bun run check` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` works
- [ ] Tested locally

## Related
Closes #123

## Checklist
- [ ] Follows style
- [ ] Self-reviewed
- [ ] No `console.*`
- [ ] Updated with `dev`
```

### Best Practices

Do:
- Keep PRs small (< 500 lines)
- One feature per PR
- Clear description
- Respond to feedback quickly

Don't:
- Mix features in one PR
- Force push after review
- Ignore feedback
- Commit to `main`/`dev` directly

---

## Code Style

### TypeScript

- Proper type annotations where useful
- `any` is allowed for Elysia/WS patterns (ESLint `no-explicit-any` is off)
- Use `const` by default, `let` only when reassignment is needed

```typescript
// const for values that don't change
const userName = 'John';
const config = { port: 9141 };

// let only when the value will be reassigned
let retryCount = 0;
retryCount++;
```

### Svelte 5

Use runes. In `.svelte` files, `let` is only needed for mutable state:

```svelte
<script lang="ts">
  // let — required for $state (mutable) and $bindable (two-way binding)
  let count = $state(0);
  let { value = $bindable('') }: Props = $props();

  // const — for $derived (read-only), $props (no bindable), functions, static values
  const doubled = $derived(count * 2);
  const { label, disabled }: Props = $props();
  const MAX_ITEMS = 100;
  const handleClick = () => count++;
</script>
```

### Naming

```typescript
// camelCase: variables, functions
const userName = 'John';

// PascalCase: classes, types
class UserManager {}

// UPPER_SNAKE_CASE: constants
const MAX_RETRIES = 3;

// kebab-case: files
// user-manager.ts
```

### Logging

Use `debug` module:

```typescript
import { debug } from './utils/debug';
debug.log('User logged in', { userId });
```

### Comments

Explain WHY, not WHAT:

```typescript
// Good
// Retry 3 times because API is unreliable
const maxRetries = 3;

// Bad
// Set retries to 3
const maxRetries = 3;
```

### Formatting

- Tabs for indentation
- Single quotes
- Semicolons
- No prettier — formatting is not enforced by tooling

---

## Found a Bug?

### Report

1. Search existing issues
2. Create new issue with template:

```markdown
## Description
What's wrong?

## Steps
1. Step 1
2. Step 2
3. Error

## Expected vs Actual
Expected: ...
Actual: ...

## Environment
- Clopen: `clopen --version`
- Bun: `bun --version`
- OS: Windows/Mac/Linux
```

### Fix

```bash
git checkout -b fix/descriptive-name
# Fix & test
bun run check && bun run lint && bun run build
git commit -m "fix: resolve issue #123"
git push origin fix/descriptive-name
# Create PR with "Fixes #123"
```

---

## Suggest Feature?

### Request

1. Check existing issues & roadmap
2. Create issue:

```markdown
## Feature
What do you want?

## Problem
What problem does this solve?

## Solution
How should it work?

## Alternatives
Other approaches?
```

### Implement

```bash
# Get approval first, then:
git checkout -b feature/descriptive-name
# Implement & test
bun run check && bun run lint && bun run build
git commit -m "feat(scope): add feature"
git push origin feature/descriptive-name
# Create PR with "Closes #123"
```

---

## Commands

```bash
bun run dev          # Dev server
bun run check        # Type check (svelte-check)
bun run lint         # Lint (ESLint)
bun run lint:fix     # Auto-fix lint issues
bun run build        # Build
bun run start        # Production server
```

---

## Troubleshooting

### Type Errors

```bash
rm -rf node_modules bun.lockb
bun install
```

### Lint Errors

```bash
bun run lint:fix
```

### Git Conflicts

```bash
git fetch upstream
git rebase upstream/main
# Resolve conflicts
git add .
git rebase --continue
```

### Port in Use

```bash
# Unix/Mac
lsof -ti:9141 | xargs kill -9

# Windows
netstat -ano | findstr :9141
taskkill /PID <PID> /F
```

---

## Resources

- [TypeScript](https://www.typescriptlang.org/docs/)
- [Svelte 5](https://svelte.dev/docs/svelte/overview)
- [Bun](https://bun.sh/docs)
- [Elysia](https://elysiajs.com/)
- [Conventional Commits](https://www.conventionalcommits.org/)

---

## Code of Conduct

- Be respectful
- Welcome newcomers
- Focus on code, not person
- Assume good intentions
- Help others learn

---

## Questions?

- [Issues](https://github.com/myrialabs/clopen/issues)
- [Discussions](https://github.com/myrialabs/clopen/discussions)

---

**Thank you for contributing!**
