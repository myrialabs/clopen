/**
 * Engine sync for Skills — a thin adapter over the shared artifact framework
 * (`backend/artifacts/`).
 *
 * Materialization by engine:
 *   - NATIVE (Claude, Qwen, Copilot, Pi): mirror each enabled skill folder into
 *     the engine's skills dir.
 *   - SYNTHETIC (Codex, OpenCode, Cline, Cursor): no native skills dir, so the
 *     preamble (name + description + absolute SKILL.md path) is injected into
 *     each turn's prompt instead of a shared global memory file — a global file
 *     can't encode a per-session Profile and leaks across concurrent sessions.
 *
 * Only `auto`-triggered skills are ADVERTISED. A `slash`-only skill is invoked
 * by the user and expanded by Clopen (see `./invoke.ts`), so listing it here
 * would just invite the model to run it unprompted.
 *
 * Sync never throws — a stream never breaks because skills couldn't sync.
 */

import { skillQueries, parseTriggers } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import {
	materializeArtifacts,
	resolveArtifact,
	isPromptScopedEngine,
	writeManagedBlock,
	markersForType,
	ARTIFACT_ENGINES,
	type ManagedArtifact,
	type ArtifactEngine
} from '$backend/artifacts';
import { artifactFilter } from '$backend/profiles';
import { getSkillMdPath, getSkillDir } from './store';
import { stat } from 'node:fs/promises';

/** Kept for backwards-compatible imports; identical to {@link ArtifactEngine}. */
export type SkillEngine = ArtifactEngine;

/** The skills preamble — exact original wording, without the markers (added by the writer). */
function buildSkillsPreamble(items: ManagedArtifact[]): string {
	if (items.length === 0) return '';
	const lines: string[] = [
		'# Available Skills',
		'',
		'You have access to the following skills. Each is a set of instructions for a',
		'specific kind of task. When the user\'s request matches a skill\'s purpose, READ',
		'its SKILL.md file with your file-reading tool to load the full instructions',
		'before proceeding. Only load a skill when it is relevant.',
		''
	];
	for (const skill of items) {
		lines.push(`- **${skill.name}** — ${skill.description}`);
		lines.push(`  Instructions: ${getSkillMdPath(skill.slug)}`);
	}
	return lines.join('\n');
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

/**
 * The skills that apply to a stream, already narrowed by the active Profile.
 * Shared by the native file materializer ({@link syncSkills}) and the synthetic
 * per-session prompt injection ({@link buildSkillsPromptContext}) so both see an
 * identical set.
 *
 * A profile is the source of truth for what's active: an item it references is
 * included even if globally disabled, and its enable toggle is ignored. With no
 * profile filter, only the globally-enabled set applies.
 *
 * With `autoOnly`, `slash`-only skills are excluded. They exist to be invoked by
 * name, and Clopen expands them itself, so an engine must neither be told about
 * them nor be given a copy it could act on. Their content is still reachable —
 * the canonical store is what the preamble and `uses:` reference by path.
 */
export function resolveEnabledSkills(profileId?: number, options?: { autoOnly?: boolean }): ManagedArtifact[] {
	const filter = artifactFilter(profileId, 'skill');
	const rows = (filter ? skillQueries.getAll() : skillQueries.getEnabled())
		.filter(r => !filter || filter.has(r.slug))
		.filter(r => !options?.autoOnly || parseTriggers(r.triggers).includes('auto'));
	return rows.map(r => ({
		slug: r.slug,
		name: r.name,
		description: r.description,
		sourceDir: getSkillDir(r.slug)
	}));
}

/**
 * Whether skills for this engine are delivered per-session via prompt injection
 * INSTEAD of the shared global memory file — true only for a synthetic (no native
 * dir) skill target on a prompt-scoped engine. Native skill engines
 * (Claude/Qwen/Copilot/Pi) keep the folder mirror+prune.
 */
function skillsViaPromptInjection(engine: SkillEngine): boolean {
	const synthetic = resolveArtifact('skill', { engine, scope: 'global' }).format === 'preamble-region';
	return synthetic && isPromptScopedEngine(engine);
}

/**
 * The profile-scoped skills preamble for PER-SESSION injection into a synthetic
 * engine's prompt (Codex/OpenCode/Copilot/Cline/Cursor). Returns '' when no skill
 * applies.
 */
export function buildSkillsPromptContext(profileId?: number): string {
	return buildSkillsPreamble(resolveEnabledSkills(profileId, { autoOnly: true }));
}

/**
 * Sync enabled skills for one engine. Safe to call at every stream start.
 * Never throws: failures are logged and swallowed so streaming is unaffected.
 */
export async function syncSkills(engine: SkillEngine, profileId?: number): Promise<void> {
	try {
		const viaPrompt = skillsViaPromptInjection(engine);
		// Auto-only, in the native dir as well as the preamble. Mirroring a
		// slash-only skill into e.g. Claude's `skills/` would hand it to Claude's
		// own Skill tool, which is precisely the autonomous invocation that trigger
		// rules out. Nothing is lost by withholding it: the canonical store is what
		// the preamble and `uses:` point at, and Clopen expands `/slug` itself.
		const enabled: ManagedArtifact[] = viaPrompt ? [] : resolveEnabledSkills(profileId, { autoOnly: true });
		const managedSlugs = skillQueries.getAll().map(s => s.slug);
		await materializeArtifacts('skill', { engine, scope: 'global' }, {
			enabled,
			managedSlugs,
			buildPreamble: buildSkillsPreamble
		});
		debug.log('skills', `🧩 Synced ${enabled.length} skill(s) → ${engine}${viaPrompt ? ' (per-session injection)' : ''}`);
	} catch (error) {
		debug.warn('skills', `⚠️ Skill sync for ${engine} failed (continuing without):`, error);
	}
}

/**
 * Remove everything earlier versions materialized for the separate Commands
 * feature: the per-engine command/prompt directories AND any `CLOPEN:COMMANDS`
 * block left inside a memory file.
 *
 * Commands are `slash` Skills now and are expanded by Clopen before the prompt
 * reaches the engine (see `./invoke.ts`), so nothing should be written to those
 * locations any more. Without this sweep a renamed or deleted command would keep
 * being offered by Claude's or Codex's own command picker forever.
 *
 * Materializing an EMPTY set is exactly the right primitive: in an exclusive
 * (Clopen-owned, isolated) directory it prunes every entry, and for a synthetic
 * target it strips the managed block while preserving the user's own content.
 */
export async function stripLegacyCommandArtifacts(engine: ArtifactEngine): Promise<void> {
	try {
		const ctx = { engine, scope: 'global' } as const;
		const resolution = resolveArtifact('command', ctx);
		const directoryBacked = resolution.format === 'folder-md' || resolution.format === 'single-md';
		if (directoryBacked && !(await pathExists(resolution.locateEffective(ctx)))) {
			// Nothing was ever written there. Don't let the generic materializer
			// create the directory just to find it empty — but a stale managed block
			// can still exist in the memory file from before this engine had a
			// native command dir, so clear that unconditionally.
			const memoryFile = resolveArtifact('instruction', ctx).locateEffective(ctx);
			if (memoryFile) await writeManagedBlock(memoryFile, '', markersForType('command'));
			return;
		}
		await materializeArtifacts('command', ctx, { enabled: [], managedSlugs: [] });
	} catch (error) {
		debug.warn('skills', `⚠️ Legacy command cleanup for ${engine} failed (continuing):`, error);
	}
}

/** Re-sync every engine — used after a mutation so changes propagate eagerly. */
export async function syncSkillsAllEngines(): Promise<void> {
	await Promise.all(ARTIFACT_ENGINES.map(engine => syncSkills(engine)));
}

/** Validate that a skill's SKILL.md exists on disk (used by the WS status surface). */
export async function skillFileReady(slug: string): Promise<boolean> {
	return pathExists(getSkillMdPath(slug));
}
