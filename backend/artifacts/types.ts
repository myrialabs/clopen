/**
 * Artifact framework — shared capability matrix for engine "extension" artifacts.
 *
 * Clopen manages several kinds of engine artifact (Agent Skills, custom slash
 * Commands, Subagents, project Instructions). They differ in file shape but share
 * one mechanic: a canonical source (DB metadata + on-disk store, or a repo file)
 * is MATERIALIZED into the shape each engine consumes at stream start.
 *
 * Rather than hardcode that mechanic per feature (as the original Skills sync
 * did), every `artifactType × engine × scope` combination is described by a
 * single {@link ArtifactResolution}. Generic writers/scanners (see `sync.ts` and
 * `detect.ts`) act on that description, so a new feature is a configuration in
 * `matrix.ts` — not a new copy of the sync/detect logic.
 *
 * Two materialization strategies recur, mirroring the two engine families:
 *   - NATIVE (Claude, Qwen, Copilot): the engine reads a real artifact directory.
 *     Clopen mirrors each managed folder/file there (`folder-md` / `single-md`),
 *     touching only the slugs it owns.
 *   - SYNTHETIC (Codex, OpenCode): no native concept, so Clopen injects a
 *     marker-delimited block (`preamble-region`) into the engine's global
 *     instructions file.
 *
 * `'mcp'` is intentionally reserved in {@link ArtifactType} but has NO adapter
 * here: MCP servers are not file artifacts — they are config objects composed
 * per engine and proxied through the `/mcp/ext/<slug>` bridge (see
 * `backend/mcp/`). Forcing MCP through a file writer/detector would be a
 * mis-fit, so it keeps its existing config-object path. The slot exists only so
 * the type is extensible if a file-shaped MCP concern ever appears.
 */

/**
 * Engine keys used across the framework. These are the *config-dir* slugs (e.g.
 * `'claude'`, not the `EngineType` `'claude-code'`) so they line up with
 * {@link getEngineUserConfigDir} and the original Skills sync.
 */
export type ArtifactEngine = 'claude' | 'codex' | 'copilot' | 'qwen' | 'opencode' | 'pi' | 'cline';

export const ARTIFACT_ENGINES: ArtifactEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode', 'pi', 'cline'];

/**
 * Kinds of artifact the framework can materialize. `'mcp'` is reserved (see file
 * header). `'permission'` describes engine tool allow/deny config: its ENFORCEMENT
 * is a runtime hook (see `backend/permissions/`), and the matrix entry only
 * describes the optional on-disk "honesty" file (Claude `settings.json`, Codex
 * `config.toml`) for engines that read one.
 */
export type ArtifactType = 'skill' | 'command' | 'subagent' | 'instruction' | 'mcp' | 'permission';

/** Where an artifact lives: instance-global (per engine) or inside a project repo. */
export type ArtifactScope = 'global' | 'project';

/**
 * On-disk shape of a materialized artifact.
 *   - `folder-md`     : a folder whose entry file carries frontmatter (Skills).
 *   - `single-md`     : one `.md` file per artifact (Commands, Subagents).
 *   - `preamble-region`: a managed block inside a shared instructions file.
 *   - `json`          : a JSON config file with Clopen-managed keys (Claude
 *                       `settings.json` permissions).
 *   - `toml`          : a TOML config file with a Clopen-managed marker-region
 *                       (Codex `config.toml`).
 */
export type ArtifactFormat = 'folder-md' | 'single-md' | 'preamble-region' | 'json' | 'toml';

/**
 * How much of the target file Clopen owns.
 *   - `whole-file`   : Clopen created and fully owns the file/folder.
 *   - `marker-region`: Clopen owns only a marker-delimited region; the rest is
 *                      the user's hand-written content and must never be touched.
 */
export type ArtifactOwnership = 'whole-file' | 'marker-region';

/**
 * Minimal context for resolving/writing an artifact. Designed to be extended
 * later (e.g. a `profileId?` for Prompt 4's Profiles) WITHOUT changing the
 * signature of `resolve()` — callers pass a richer context, adapters ignore
 * fields they don't use.
 */
export interface ArtifactContext {
	engine: ArtifactEngine;
	scope: ArtifactScope;
	/** Project association for `scope: 'project'` (repo-scoped artifacts). */
	projectId?: string;
	/** Absolute path to the project repo root, for project-scoped resolution. */
	projectPath?: string;
	/** Reserved for Prompt 4 — active profile scoping. Unused today. */
	profileId?: string;
}

/** A single managed artifact ready to be written to an engine target. */
export interface ManagedArtifact {
	slug: string;
	name: string;
	description: string;
	/**
	 * The canonical source folder for `folder-md` artifacts (mirrored wholesale),
	 * or `undefined` when the content is produced inline.
	 */
	sourceDir?: string;
	/** Serialized document for `single-md` artifacts (frontmatter + body). */
	document?: string;
}

/** An artifact discovered on disk (managed by Clopen or pre-existing / user-owned). */
export interface DetectedArtifact {
	slug: string;
	name: string;
	description: string;
	/** Absolute path to the artifact (folder or file). */
	path: string;
	/** True when the path is a Clopen-managed effective location. */
	managed: boolean;
	/** True when the path is a real standard location eligible for adopt/link. */
	adoptable: boolean;
}

/**
 * The capability descriptor for one `artifactType × engine × scope`. Generic
 * writers/scanners consume this; concrete file mechanics live in `sync.ts` /
 * `detect.ts`, keyed off `format`/`ownership`.
 */
export interface ArtifactResolution {
	supported: boolean;
	format: ArtifactFormat;
	ownership: ArtifactOwnership;
	/**
	 * True when Clopen EXCLUSIVELY owns the effective directory (an isolated
	 * engine config dir the user never writes to). Such dirs can be pruned of
	 * ANY entry not currently enabled — which is required to remove artifacts
	 * whose DB row was deleted (their slug is gone from `managedSlugs`, so a
	 * managed-slug-only prune would orphan the file forever). Shared dirs (e.g.
	 * the user's real `~/.qwen/skills`) are NOT exclusive: only known managed
	 * slugs are pruned there, never the user's own files.
	 */
	exclusive?: boolean;
	/**
	 * The location Clopen writes to for this engine/scope — an isolated engine
	 * dir (global) or a repo path (project). Returns a directory for
	 * `folder-md`/`single-md`, a file for `preamble-region`.
	 */
	locateEffective(ctx: ArtifactContext): string;
	/**
	 * Real standard locations to scan for "detect & link" (global only) — e.g.
	 * `~/.claude/commands`. Absent when there is nothing outside Clopen's dirs.
	 */
	locateReal?(ctx: ArtifactContext): string[];
}

/** Marker used to delimit Clopen-managed regions inside shared files. */
export interface ArtifactMarkers {
	start: string;
	end: string;
}
