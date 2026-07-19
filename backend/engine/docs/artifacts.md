[← Engine adapter guide](../README.md)

## 8. Artifacts & the extension layer

The adapters stream chat; **artifacts** are the reusable "extensions" the user
manages in **Settings → Artifacts & Access** that shape what each engine sees and
may do during that stream — Skills, Commands, Subagents, Instructions,
Permissions, Profiles, and Connectors (MCP).

They are a **separate subsystem** (`backend/artifacts/` + one module per feature)
that meets the adapter layer at exactly one seam: `backend/engine/artifact-sync.ts`,
called at stream start by every adapter. This section is the **map + integration
point** — the per-feature source of truth is the doc-comment atop each module
(`backend/artifacts/types.ts`, `matrix.ts`, and each feature's `service.ts`).

### 8.1 What lives under "Artifacts & Access"

Seven menus, each a canonical source (DB metadata + on-disk store, or a repo
file) that is **materialized** per engine. Coverage differs by engine because
each exposes a different native surface.

| Menu (UI)        | Backend module          | WS router                  | Materialized as |
|------------------|-------------------------|----------------------------|-----------------|
| Connectors (MCP) | `backend/mcp/`          | `backend/ws/mcp/`          | config object + `/mcp/ext/<slug>` bridge — **not** a file artifact (see §8.5) |
| Skills           | `backend/skills/`       | `backend/ws/skills/`       | `folder-md` in a native dir, or synthetic preamble |
| Commands         | `backend/commands/`     | `backend/ws/commands/`     | `single-md` in a native dir, or synthetic preamble |
| Subagents        | `backend/subagents/`    | `backend/ws/subagents/`    | `single-md` in a native dir, or synthetic preamble |
| Instructions     | `backend/instructions/` | `backend/ws/instructions/` | `preamble-region` inside the engine memory file |
| Permissions      | `backend/permissions/`  | `backend/ws/permissions/`  | runtime hook (+ optional Claude `settings.json`) |
| Profiles         | `backend/profiles/`     | `backend/ws/profiles/`     | not materialized — a **bundle** that narrows the others |

`ArtifactType` (`backend/artifacts/types.ts`) is
`skill | command | subagent | instruction | mcp | permission`. Two deliberate
mismatches with the menu list:

- **`mcp` is a reserved slot with no adapter** — MCP servers are config objects,
  not files, so they keep their own path (§8.5).
- **Profiles is not an artifact type** — it is a bundling/scoping concept layered
  on top of the others (§8.4).

### 8.2 The capability matrix

`backend/artifacts/matrix.ts` is the single table the generic writer (`sync.ts`)
and scanner (`detect.ts`) consult. For every `artifactType × engine × scope` it
resolves **where** an artifact is materialized and **in what shape**
(`ArtifactResolution`). Adding a feature is a new row here — not new sync code.

Two strategies recur, mirroring the two engine families:

- **NATIVE** (Claude, Qwen, Copilot) — the engine reads a real artifact
  directory (Claude `<config>/{skills,commands,agents}`, OpenCode
  `<config>/opencode/{command,agent}`, Codex `$CODEX_HOME/prompts`). Clopen
  mirrors only the slugs it owns into that dir (`ownership: 'whole-file'`).
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
| `syncEngineArtifacts(engine, profileId?)` | Materializes Commands, Subagents, and Instructions for the engine. **Global scope only** — writing project-scoped instructions into a repo's `CLAUDE.md` / `AGENTS.md` touches the working tree, which must be an explicit user action, never silent at stream start. |
| `buildArtifactsPromptContext(profileId?)` | Returns the combined, profile-scoped Skills + Commands + Subagents preamble that **prompt-scoped engines** (OpenCode / Codex / Copilot) inject into each turn's prompt. |

> **Sequential, not `Promise.all`.** On synthetic engines all three sync calls
> write into the same `AGENTS.md`; running them concurrently would race the
> read-modify-write and drop blocks. Each call swallows its own errors, so one
> failure never stops the others and the function never throws.

`profileId` scopes Commands/Subagents to the active Profile's bundle (§8.4);
Instructions are never profile-bundled. Prompt-scoped engines need the preamble
because they read artifacts through a channel shared across sessions and not
reliably re-read per turn — the prompt is the one genuinely per-session channel.

### 8.4 Per-artifact map

| Artifact | Canonical source | Scope | Sync behaviour |
|----------|------------------|-------|----------------|
| **Skills** (`backend/skills/`) | DB metadata + on-disk store; marketplace-installable | global, project | mirrored folder (`folder-md`) on native engines, synthetic preamble otherwise. Keeps its own `syncSkills` call — the framework generalized this mechanic |
| **Commands** (`backend/commands/`) | custom slash commands | global, project | one `.md` per command into the engine command dir, or synthetic preamble. Profile-bundled |
| **Subagents** (`backend/subagents/`) | specialized delegated agents | global, project | one `.md` per subagent, or synthetic preamble. Profile-bundled |
| **Instructions** (`backend/instructions/`) | a shared instruction block | global, project | marker region inside the engine memory file (`CLAUDE.md` / `QWEN.md` / `AGENTS.md`). Global set always synced in full; never profile-bundled |
| **Permissions** (`backend/permissions/`) | per-engine tool allow/deny | global, project | **enforcement is a runtime hook** (`resolvePermissionsFromDb` + `isToolAllowed`) each adapter consults at its auto-approve point. The matrix only describes the optional on-disk "honesty" file, which today only Claude reads (a managed `permissions` key merged into its isolated `settings.json`) |
| **Profiles** (`backend/profiles/`) | a named bundle of slugs | per session | not materialized. Narrows which instance-global artifacts are active: effective profile = `chat_sessions.profile_id ?? projects.default_profile_id`, resolved once at stream start and threaded down as `profileId`. Only constrains the types it references (`artifactFilter` → `null` = unconstrained), so a Commands-only profile never disables every Skill |

### 8.5 Connectors (MCP)

MCP is part of Artifacts & Access in the UI but is **not** part of this file
framework — it has its own subsystem. MCP servers are config objects composed
per engine and proxied through the `/mcp/ext/<slug>` bridge, so forcing them
through a file writer/detector would be a mis-fit; the `'mcp'` slot in
`ArtifactType` exists only for future extensibility. Profiles can still reference
MCP connectors as bundle items (§8.4).

For MCP's own architecture — internal `defineServer()` tools, the OAuth client,
the remote HTTP bridge, per-engine config, and tool overrides — see
[`backend/mcp/README.md`](../../mcp/README.md). The engine-side MCP reuse rules
live in §10.12 (internal bridge) and §10.18 (external servers).

---

See also: [`backend/artifacts/`](../../artifacts/) (matrix, generic sync/detect,
authoritative doc-comments) and §2.6 for where `artifact-sync.ts` sits in the
adapter file taxonomy.

---
