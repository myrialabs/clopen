/**
 * Capability matrix — resolves, for a given `artifactType × engine × scope`, WHERE
 * and in WHAT SHAPE the artifact is materialized. This is the single table the
 * generic writer/scanner consult; adding a feature means adding rows here, not
 * new sync code.
 *
 * Path conventions:
 *   - Global effective paths live in the engine's ISOLATED config dir
 *     (`getEngineUserConfigDir`) so Clopen never mixes with the user's own CLI
 *     usage — except Qwen/Copilot skills, which resolve their dir from `$HOME`
 *     with no override (see the original Skills sync rationale).
 *   - Project effective paths live inside the repo (`.claude/…`, `CLAUDE.md`, …).
 *   - `locateReal` returns the user's REAL standard locations (`~/.claude/…`),
 *     scanned by "detect & link" so existing on-disk artifacts can be adopted.
 *
 * Non-Claude synthetic targets follow each engine's documented global-memory
 * convention but are BEST-EFFORT / unverified — surfaced with a marker so the UI
 * never claims they definitely take effect.
 */

import { join } from 'path';
import { homedir } from 'os';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import type {
	ArtifactContext,
	ArtifactEngine,
	ArtifactFormat,
	ArtifactResolution,
	ArtifactType,
	ArtifactScope
} from './types';

/** Per-engine global memory file that synthetic artifacts / instructions target. */
function memoryFileName(engine: ArtifactEngine): string {
	switch (engine) {
		case 'claude': return 'CLAUDE.md';
		case 'qwen': return 'QWEN.md';
		// Codex, OpenCode and Copilot all standardise on AGENTS.md.
		default: return 'AGENTS.md';
	}
}

/** Absolute path to the engine's global memory file (isolated dir). */
function globalMemoryFile(engine: ArtifactEngine): string {
	const base = getEngineUserConfigDir(engine);
	// OpenCode nests its config under an `opencode/` subdir (XDG layout).
	if (engine === 'opencode') return join(base, 'opencode', memoryFileName(engine));
	return join(base, memoryFileName(engine));
}

/** Absolute path to a project-repo memory file. */
function projectMemoryFile(engine: ArtifactEngine, projectPath: string): string {
	return join(projectPath, memoryFileName(engine));
}

/**
 * Native artifact directory for a `(type, engine, scope)`, or null when that
 * engine has NO native location for the type (→ falls back to a synthetic
 * preamble). Each engine's directory/format differs, so this is an explicit
 * table rather than a `<subdir>` convention:
 *   - Claude: `<config>/{skills,commands,agents}` (global) or `.claude/…` (project).
 *   - OpenCode: markdown commands in `<config>/opencode/command/` and subagents in
 *     `<config>/opencode/agent/` — https://opencode.ai/docs/commands, /docs/agents.
 *   - Codex: markdown custom prompts in `$CODEX_HOME/prompts/` (global only).
 *   - Qwen/Copilot: only skills, resolved from the real `$HOME`.
 */
function nativeDir(type: ArtifactType, ctx: ArtifactContext): string | null {
	const { engine, scope, projectPath } = ctx;
	const base = getEngineUserConfigDir(engine);
	const proj = scope === 'project' ? projectPath : undefined;

	if (type === 'skill') {
		switch (engine) {
			case 'claude': return scope === 'global' ? join(base, 'skills') : proj ? join(proj, '.claude', 'skills') : null;
			case 'qwen': return scope === 'global' ? join(homedir(), '.qwen', 'skills') : null;
			case 'copilot': return scope === 'global' ? join(homedir(), '.copilot', 'skills') : null;
			default: return null;
		}
	}
	if (type === 'command') {
		switch (engine) {
			case 'claude': return scope === 'global' ? join(base, 'commands') : proj ? join(proj, '.claude', 'commands') : null;
			case 'opencode': return scope === 'global' ? join(base, 'opencode', 'command') : proj ? join(proj, '.opencode', 'command') : null;
			case 'codex': return scope === 'global' ? join(base, 'prompts') : null;
			default: return null;
		}
	}
	if (type === 'subagent') {
		switch (engine) {
			case 'claude': return scope === 'global' ? join(base, 'agents') : proj ? join(proj, '.claude', 'agents') : null;
			case 'opencode': return scope === 'global' ? join(base, 'opencode', 'agent') : proj ? join(proj, '.opencode', 'agent') : null;
			default: return null;
		}
	}
	return null;
}

/** The user's REAL standard global locations for detect & link. */
function realGlobalLocations(type: ArtifactType, engine: ArtifactEngine): string[] {
	const home = homedir();
	if (type === 'skill') {
		if (engine === 'claude') return [join(home, '.claude', 'skills')];
		if (engine === 'qwen') return [join(home, '.qwen', 'skills')];
		if (engine === 'copilot') return [join(home, '.copilot', 'skills')];
	}
	if (type === 'command') {
		if (engine === 'claude') return [join(home, '.claude', 'commands')];
		if (engine === 'opencode') return [join(home, '.config', 'opencode', 'command')];
		if (engine === 'codex') return [join(home, '.codex', 'prompts')];
	}
	if (type === 'subagent') {
		if (engine === 'claude') return [join(home, '.claude', 'agents')];
		if (engine === 'opencode') return [join(home, '.config', 'opencode', 'agent')];
	}
	return [];
}

const FORMAT_BY_TYPE: Partial<Record<ArtifactType, ArtifactFormat>> = {
	// Skills mirror a whole folder; commands/subagents are one file each.
	skill: 'folder-md',
	command: 'single-md',
	subagent: 'single-md'
};

/**
 * Resolve the materialization contract for one artifact in one engine/scope.
 * Returns `{ supported: false }` for combinations with no file representation
 * (notably `'mcp'`, which is handled by the config-object path, not here).
 */
export function resolveArtifact(type: ArtifactType, ctx: ArtifactContext): ArtifactResolution {
	const { engine, scope } = ctx;

	// Instructions are always a marker-region inside the engine memory file.
	if (type === 'instruction') {
		return {
			supported: true,
			format: 'preamble-region',
			ownership: 'marker-region',
			locateEffective: (c) =>
				c.scope === 'project' && c.projectPath
					? projectMemoryFile(engine, c.projectPath)
					: globalMemoryFile(engine),
			locateReal: (c) =>
				c.scope === 'global' ? [join(homedir(), `.${engine === 'claude' ? 'claude' : engine}`, memoryFileName(engine))] : []
		};
	}

	// Permissions: enforcement is a RUNTIME hook (see backend/permissions/); the
	// matrix only describes the optional on-disk "honesty" file. Only Claude reads
	// one Clopen can safely manage — an isolated `settings.json` with a managed
	// `permissions` key (JSON). Other engines are hook-only (Qwen/Copilot) or
	// have no clean per-tool primitive (Codex/OpenCode) → no file to write; their
	// rules live purely in the DB and, where a hook exists, are enforced there.
	if (type === 'permission') {
		if (engine === 'claude') {
			return {
				supported: true,
				format: 'json',
				// Managed-KEYS, not whole-file: the isolated `settings.json` is also
				// Claude's own settings store, so materialization merges the
				// `permissions` key and preserves everything else.
				ownership: 'marker-region',
				exclusive: scope === 'global',
				locateEffective: (c) =>
					c.scope === 'project' && c.projectPath
						? join(c.projectPath, '.claude', 'settings.json')
						: join(getEngineUserConfigDir('claude'), 'settings.json')
			};
		}
		return unsupported();
	}

	// MCP has no file representation in this framework (reserved slot).
	if (type === 'mcp') {
		return unsupported();
	}

	const format = FORMAT_BY_TYPE[type];
	if (!format) return unsupported();

	if (nativeDir(type, ctx) !== null) {
		// Native engines read a real artifact directory; mirror folders/files there.
		// Exclusive when the effective dir is an ISOLATED engine config dir Clopen
		// fully owns (global scope, non-shared-home engine). Qwen/Copilot resolve
		// their skills dir from the real `$HOME`, so those are shared (not exclusive);
		// project dirs live in the user's repo, also not exclusive.
		const exclusive = scope === 'global' && engine !== 'qwen' && engine !== 'copilot';
		return {
			supported: true,
			format,
			ownership: 'whole-file',
			exclusive,
			locateEffective: (c) => nativeDir(type, c) ?? '',
			locateReal: (c) => (c.scope === 'global' ? realGlobalLocations(type, engine) : [])
		};
	}

	// Synthetic engines: inject a managed preamble block into the memory file.
	return {
		supported: true,
		format: 'preamble-region',
		ownership: 'marker-region',
		locateEffective: (c) =>
			c.scope === 'project' && c.projectPath
				? projectMemoryFile(engine, c.projectPath)
				: globalMemoryFile(engine)
	};
}

function unsupported(): ArtifactResolution {
	return {
		supported: false,
		format: 'single-md',
		ownership: 'whole-file',
		locateEffective: () => ''
	};
}

/**
 * Engines whose runtime reads artifacts through a channel that is SHARED across
 * sessions and NOT reliably re-read per turn — a persistent server/client
 * (OpenCode `opencode serve`, Codex/Copilot long-lived clients) and/or a shared
 * global memory file. For these, an on-disk/global-file filter can't express a
 * per-session Profile choice (it leaks across concurrent sessions and/or is
 * served stale), so the adapter ALSO advertises the profile-scoped set
 * per-session by injecting a preamble into the prompt (see
 * `buildArtifactsPromptContext`). Claude and Qwen are excluded: each spawns a
 * fresh per-query CLI over an isolated/pruned dir, so the on-disk filter alone
 * already scopes correctly.
 */
export const PROMPT_SCOPED_ENGINES: readonly ArtifactEngine[] = ['opencode', 'codex', 'copilot'];
export function isPromptScopedEngine(engine: ArtifactEngine): boolean {
	return PROMPT_SCOPED_ENGINES.includes(engine);
}

/** Whether a synthetic (non-native) target is best-effort/unverified for the UI. */
export function isBestEffortTarget(type: ArtifactType, engine: ArtifactEngine): boolean {
	if (type === 'instruction') return engine !== 'claude';
	// Permissions are enforced at a runtime hook on Claude/Qwen/Copilot/OpenCode
	// (OpenCode resolves the tool via its permission event's callID). Only Codex
	// has no per-call hook, so it alone is best-effort.
	if (type === 'permission') return engine === 'codex';
	return nativeDir(type, { engine, scope: 'global' }) === null;
}

export { memoryFileName };
export type { ArtifactScope };
