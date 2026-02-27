# Claude Code Guidelines

This document provides guidelines for Claude Code when working on the Clopen project.

---

## WORK PROTOCOL

### Before Coding

1. Identify which stage is currently being worked on
2. Understand the specific task that needs to be completed

### During Coding

- Follow agreed-upon architecture and patterns
- Do not change technical decisions without discussion
- Ensure code matches the established folder structure
- Use chosen libraries and frameworks
- Do NOT run `bun run dev` or `bun run build` commands
- **DO NOT USE** Task Tool for spawning agents
- **DO NOT USE** Plan Mode (EnterPlanMode)
- Work directly on requested tasks without creating plans or spawning agents

### After Coding

- Run `bun run check` command to ensure code functions properly
- Do not create any .md files unless explicitly instructed

---

## IMPORTANT RULES

1. Be **CONSISTENT** with previously made decisions
2. **COMMUNICATE** if existing plans need to be changed
3. **STOP** after each stage for review

---

## PROJECT-SPECIFIC GUIDELINES

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

- Run `bun run check` for type checking
- Ensure all TypeScript checks pass before committing

### Communication

- Report progress after each significant change
- Ask for clarification when requirements are unclear
- Discuss architectural changes before implementation

---

## DO NOT

- ❌ Spawn additional Task agents
- ❌ Enter Plan Mode
- ❌ Run dev/build commands during development
- ❌ Create documentation files without request
- ❌ Proceed without confirmation after each stage
- ❌ Use console.* directly (use debug module instead)
- ❌ Change technical stack decisions independently

---

## DO

- ✅ Follow established patterns
- ✅ Run `bun run check` after coding
- ✅ Stop and wait for confirmation between stages
- ✅ Communicate before making significant changes
- ✅ Use TypeScript throughout
- ✅ Follow Svelte 5 runes system
- ✅ Use debug module for logging
