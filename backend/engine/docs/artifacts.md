[← Engine adapter guide](../README.md)

## 8. Artifacts & the extension layer

The adapters stream chat; **artifacts** are the reusable "extensions" the user
manages in **Settings → Artifacts & Access** that shape what each engine sees and
may do during that stream — Skills, Subagents, Instructions, Permissions,
Profiles, and Integrations (MCP).

They are a **separate subsystem** (`backend/artifacts/` + one module per feature)
that meets the adapter layer at exactly one seam: `backend/engine/artifact-sync.ts`,
called at stream start by every adapter. This section is the **map + integration
point** — the per-feature source of truth is the doc-comment atop each module
(`backend/artifacts/types.ts`, `matrix.ts`, and each feature's `service.ts`).

### 8.1 What lives under "Artifacts & Access"

Six menus, each a canonical source (DB metadata + on-disk store, or a repo file)
that is **materialized** per engine. Coverage differs by engine because each
exposes a different native surface.

| Menu (UI)        | Backend module          | WS router                  | Materialized as |
|------------------|-------------------------|----------------------------|-----------------|
| Integrations     | `backend/mcp/` + `backend/integrations/` | `backend/ws/mcp/` + `backend/ws/integrations/` | config object + `/mcp/ext/<slug>` bridge — **not** a file artifact (see §8.5) |
| Skills           | `backend/skills/`       | `backend/ws/skills/`       | `folder-md` in a native dir, or synthetic preamble; `/slash` skills are expanded by Clopen (§8.6) |
| Subagents        | `backend/subagents/`    | `backend/ws/subagents/`    | `single-md` in a native dir, or synthetic preamble — only for engines that can delegate |
| Instructions     | `backend/instructions/` | `backend/ws/instructions/` | `preamble-region` inside the engine memory file, or the prompt for engines that read no such file |
| Permissions      | `backend/permissions/`  | `backend/ws/permissions/`  | runtime hook (+ optional Claude `settings.json`) |
| Profiles         | `backend/profiles/`     | `backend/ws/profiles/`     | not materialized — a **bundle** that narrows the others |

`ArtifactType` (`backend/artifacts/types.ts`) is
`skill | command | subagent | instruction | mcp | permission`. Three deliberate
mismatches with the menu list:

- **`mcp` is a reserved slot with no adapter** — MCP servers are config objects,
  not files, so they keep their own path (§8.5).
- **`command` is a legacy slot** — Commands merged into Skills (migration 079,
  §8.6). Nothing is materialized for it any more; the type survives so
  `stripLegacyCommandArtifacts` can clean out what older versions wrote.
- **Profiles is not an artifact type** — it is a bundling/scoping concept layered
  on top of the others (§8.4).

### 8.2 The capability matrix

`backend/artifacts/matrix.ts` is the single table the generic writer (`sync.ts`)
and scanner (`detect.ts`) consult. For every `artifactType × engine × scope` it
resolves **where** an artifact is materialized and **in what shape**
(`ArtifactResolution`). Adding a feature is a new row here — not new sync code.

Two strategies recur, mirroring the two engine families:

- **NATIVE** (Claude, Qwen, Copilot) — the engine reads a real artifact
  directory (Claude `<config>/{skills,agents}`, OpenCode
  `<config>/opencode/agent`, Pi `<agentDir>/skills`). Clopen mirrors only the
  slugs it owns into that dir (`ownership: 'whole-file'`).
- **SYNTHETIC** (Codex, OpenCode) — no native concept for a type, so Clopen
  injects a marker-delimited block (`preamble-region`) into the engine's global
  memory file (`AGENTS.md`).

> **Synthetic targets are best-effort.** They follow each engine's documented
> global-memory convention but are unverified, and are surfaced with a marker so
> the UI never claims they definitely take effect.

**Scope.** `global` paths live in the engine's *isolated* config dir
(`getEngineUserConfigDir`) so Clopen never mixes with the user's own CLI usage —
except Qwen/Copilot skills, which resolve from the real `$HOME`. `project` paths
live in the repo (`.claude/…`, `CLAUDE.md`, …). The isolation itself is §10.19;
the matrix only decides *which* isolated path each artifact lands in.
`matrix.ts`'s `locateReal` returns the user's *real* standard locations, scanned
by **detect & link** so existing on-disk artifacts can be adopted.

### 8.3 Integration point — `artifact-sync.ts`

`backend/engine/artifact-sync.ts` is the **only** file where the artifact
subsystem meets the adapter layer. Every adapter (`claude`, `qwen`, `codex`,
`copilot`, `opencode`) calls into it from `stream.ts` at stream start, right
after `syncSkills`, so all features share one trigger point without each adapter
growing separate calls (see the file taxonomy in §2.6).

| Export | Role |
|--------|------|
| `syncEngineArtifacts(engine, profileId?)` | Strips legacy Command artifacts, then materializes Subagents and Instructions for the engine. **Global scope only** — writing project-scoped instructions into a repo's `CLAUDE.md` / `AGENTS.md` touches the working tree, which must be an explicit user action, never silent at stream start. |
| `buildArtifactsPromptContext(engine, profileId?)` | Returns the combined, profile-scoped preamble that **prompt-scoped engines** (OpenCode / Codex / Copilot / Cline / Cursor) inject into each turn's prompt. |

> **Sequential, not `Promise.all`.** On synthetic engines these calls write into
> the same `AGENTS.md`; running them concurrently would race the
> read-modify-write and drop blocks. Each call swallows its own errors, so one
> failure never stops the others and the function never throws.

`profileId` scopes Skills/Subagents to the active Profile's bundle (§8.4);
Instructions are never profile-bundled. Prompt-scoped engines need the preamble
because they read artifacts through a channel shared across sessions and not
reliably re-read per turn — the prompt is the one genuinely per-session channel.

`engine` decides whether **Instructions** ride along in that preamble.
`readsGlobalMemoryFile()` is false for Cline and Cursor: both are in-process SDKs
that build their own system prompt and resolve ambient rules from the workspace,
so an `AGENTS.md` written into their isolated config dir is a file nothing opens.
For them the prompt is the only channel — before this, Instructions silently
never applied there at all.

### 8.4 Per-artifact map

| Artifact | Canonical source | Scope | Sync behaviour |
|----------|------------------|-------|----------------|
| **Skills** (`backend/skills/`) | DB metadata + on-disk store; marketplace-installable | global, project | mirrored folder (`folder-md`) on native engines, synthetic preamble otherwise. Only `auto`-triggered skills are advertised; `slash` ones are expanded by Clopen (§8.6). Profile-bundled |
| **Subagents** (`backend/subagents/`) | specialized delegated agents | global, project | one `.md` per subagent, or synthetic preamble — and **nothing at all** for engines `canDelegateSubagents()` rejects (Codex, Copilot, Qwen), which have no surface to register one with. Profile-bundled |
| **Instructions** (`backend/instructions/`) | a shared instruction block | global, project | marker region inside the engine memory file (`CLAUDE.md` / `QWEN.md` / `AGENTS.md`). Global set always synced in full; never profile-bundled |
| **Permissions** (`backend/permissions/`) | per-engine tool allow/deny | global, project | **enforcement is a runtime check** (`resolvePermissionsFromDb` + `isToolAllowed`) each adapter runs at whichever surface fires for every tool call — for Claude a `PreToolUse` hook, since `bypassPermissions` auto-approves before `canUseTool` is consulted. The matrix only describes the optional on-disk file, which today only Claude reads (a managed `permissions` key merged into its isolated `settings.json`); its `deny` rules do bite even under `bypassPermissions`, an allowlist has no on-disk equivalent |
| **Profiles** (`backend/profiles/`) | a named bundle of slugs | per session | not materialized. Narrows which instance-global artifacts are active: effective profile = `chat_sessions.profile_id ?? projects.default_profile_id`, resolved once at stream start and threaded down as `profileId`. Only constrains the types it references (`artifactFilter` → `null` = unconstrained), so a Subagents-only profile never disables every Skill |

### 8.5 Integrations (MCP + connected accounts)

Integrations sit under Artifacts & Access in the UI but are **not** part of this
file framework — they have their own subsystem. MCP servers are config objects
composed per engine and proxied through the `/mcp/ext/<slug>` bridge, so forcing
them through a file writer/detector would be a mis-fit; the `'mcp'` slot in
`ArtifactType` exists only for future extensibility. Profiles can still
reference connectors as bundle items (§8.4).

Two modules, one menu:

- `backend/mcp/` — the protocol: install, proxy, per-engine tool exposure,
  MCP-level OAuth.
- `backend/integrations/` — the connected account and its credential (sealed at
  rest, see `backend/database/crypto/`). An account with the `agent-tools`
  capability **projects** an `mcp_servers` row; other capabilities project onto
  other surfaces, or onto none yet.

Nothing on the adapter path can tell a projected row from a hand-installed one,
which is the point: this layer stays off the path MCP config already flows
through.

For MCP's own architecture — internal `defineServer()` tools, the OAuth client,
the remote HTTP bridge, per-engine config, and tool overrides — see
[`backend/mcp/README.md`](../../mcp/README.md). The engine-side MCP reuse rules
live in §10.12 (internal bridge) and §10.18 (external servers).

### 8.6 Skills cover both triggers (the Commands merge)

Skills and Commands used to be two menus over one mechanic: the same
frontmatter + Markdown document, the same `materializeArtifacts` call, the same
profile bundling. They differed only in **who pulls the trigger**. Migration 079
folded them into one artifact with two independent switches:

| `triggers` | Invoked by | Delivery |
|------------|-----------|----------|
| `auto`  | the model, from the skill's `description` | advertised in the skills preamble / native skills dir |
| `slash` | the user, by typing `/<slug>` | expanded by Clopen before the prompt reaches the engine |

A skill can carry both. Two frontmatter keys come with the merge:
`argument-hint` (shown in the chat "/" picker) and `uses` — a list of sibling
slugs force-loaded whenever the skill runs, which is how one invocation pulls in
several skills **deterministically** instead of hoping the model notices them.
The spec tells runtimes to ignore frontmatter keys they don't model, so a Clopen
skill is still a portable SKILL.md.

**Clopen is the invoker, not the engine.** `backend/skills/invoke.ts` resolves
`/<slug>`, substitutes `$ARGUMENTS` / `$1`…`$9`, prepends the `uses` load block
(absolute SKILL.md paths, so bundled `scripts/` and `references/` stay reachable),
and `backend/chat/stream-manager.ts` swaps the result into the ENGINE prompt
only — the saved user message keeps the `/slug` the user typed, exactly like the
handoff and memory blocks beside it.

This is the point of the merge. Only four of the eight engines have a native
command directory (Claude, Codex, OpenCode, Pi); the other four were handed a
list of command *names* with no bodies and no argument substitution, so `/review-pr
123` produced an invented procedure. Expanding once, centrally, makes a slash
skill behave identically everywhere.

The old per-command **model override did not survive the merge**. A skill runs on
the session's model whichever trigger fires; pinning a model on the `slash` half
only would have made two halves of one artifact behave differently for a reason
no one could see in the UI.

Nothing is written to the native command directories any more.
`stripLegacyCommandArtifacts()` (called from `syncEngineArtifacts`) clears them
and any `CLOPEN:COMMANDS` block, so a renamed or deleted command stops being
offered by an engine's own picker.

**The migration copies, it does not move.** Each `{clopenDir}/commands/<slug>.md`
is read into `{clopenDir}/skills/<slug>/SKILL.md` and then left where it is, and
an existing SKILL.md is never overwritten with an empty body. A command document
is prose the user wrote and Clopen holds the only copy of; a migration that
deletes the source gets exactly one attempt, and against a database whose files
aren't beside it — restored from another machine, a data dir assembled by hand —
it would replace every prompt with nothing, irreversibly. A stale `commands/`
folder is the cheap half of that trade.

---

See also: [`backend/artifacts/`](../../artifacts/) (matrix, generic sync/detect,
authoritative doc-comments) and §2.6 for where `artifact-sync.ts` sits in the
adapter file taxonomy.

---
