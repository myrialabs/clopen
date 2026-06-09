# AI Agent Guidelines for Clopen

This document provides guidelines for AI coding agents when working on the Clopen project.

---

## WORK PROTOCOL

### Before Coding

1. Identify which stage is currently being worked on
2. Understand the specific task that needs to be completed
3. **For PR-related tasks** (e.g., "review PR #123", "check PR X"), read `MAINTAINERS.md` first to understand the PR workflow, review process, and maintainer conventions

### During Coding

- Follow agreed-upon architecture and patterns
- Do not change technical decisions without discussion
- Ensure code matches the established folder structure
- Use chosen libraries and frameworks
- Do NOT run `bun run dev` or `bun run build` commands

### After Coding

- Run `bun run check` and `bun run lint` to ensure code functions properly
- Do not create any .md files unless explicitly instructed
- Suggest a branch name and commit message following CONTRIBUTING.md conventions:
  - Branch: `<type>/<description>` — lowercase, kebab-case, concise
  - Commit: `<type>(<scope>): <subject>` — imperative mood, lowercase, no period, max 72 chars
  - Do NOT create the branch or commit automatically — only suggest the names for review

---

## IMPORTANT RULES

1. Be **CONSISTENT** with previously made decisions
2. **COMMUNICATE** if existing plans need to be changed
3. **STOP** after each stage for review

---

## PROJECT-SPECIFIC GUIDELINES

### Runtime & Package Manager

- **Bun-only project** — Node.js and Deno are NOT supported
- Always use `bun` commands (never npm/pnpm/yarn)
- Runtime checks exist in `bin/clopen.ts` and `backend/index.ts`

### Architecture

- **Backend:** Bun + Elysia with WebSocket architecture
- **Frontend:** Svelte 5 with runes system ($state, $derived, $effect)
- **Database:** SQLite with migration system

### Code Style

- TypeScript throughout the entire codebase
- Use `const` by default; use `let` only when reassignment is needed
- In `.svelte` files: `let` for `$state` and `$bindable`; `const` for `$derived`, `$props`, functions
- Use Svelte 5 runes for state management (not traditional stores)
- Follow Tailwind CSS v4 conventions
- Use custom logger module (`debug`) instead of console.*

### Testing

- Run `bun run check` for type checking and `bun run lint` for linting
- Ensure all checks pass before committing

### Communication

- Report progress after each significant change
- Ask for clarification when requirements are unclear
- Discuss architectural changes before implementation

---

## DO NOT

- Run dev/build commands during development
- Create documentation files without request
- Proceed without confirmation after each stage
- Use console.* directly (use debug module instead)
- Change technical stack decisions independently

---

## DO

- Follow established patterns
- Run `bun run check` and `bun run lint` after coding
- Stop and wait for confirmation between stages
- Communicate before making significant changes
- Use TypeScript throughout
- Follow Svelte 5 runes system
- Use debug module for logging
