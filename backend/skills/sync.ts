/**
 * Engine sync for Skills — now a thin adapter over the shared artifact framework
 * (`backend/artifacts/`). Skills were the original per-feature sync; that logic
 * has been generalized into {@link materializeArtifacts}, and this module simply
 * supplies the skill item set plus the exact preamble text skills have always
 * emitted (preserved verbatim so retrofitting introduces no behavior change).
 *
 * Materialization by engine (unchanged):
 *   - NATIVE (Claude, Qwen, Copilot): mirror each enabled skill folder into the
 *     engine's skills dir.
 *   - SYNTHETIC (Codex, OpenCode): inject a marker-delimited "skills preamble"
 *     (name + description + absolute SKILL.md path) into the engine's global
 *     memory file. These synthetic targets are best-effort/unverified.
 *
 * Sync never throws — a stream never breaks because skills couldn't sync.
 */

import { skillQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { materializeArtifacts, resolveArtifact, isPromptScopedEngine, type ManagedArtifact, type ArtifactEngine } from '$backend/artifacts';
import { artifactFilter } from '$backend/profiles';
import { getSkillMdPath, getSkillDir } from './store';
import { stat } from 'node:fs/promises';

/** Kept for backwards-compatible imports; identical to {@link ArtifactEngine}. */
export type SkillEngine = ArtifactEngine;

interface EnabledSkill {
	slug: string;
	name: string;
	description: string;
}

function getEnabledSkills(): EnabledSkill[] {
	return skillQueries.getEnabled().map(r => ({ slug: r.slug, name: r.name, description: r.description }));
}

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
 * profile filter, only the globally-enabled set applies (unchanged behaviour).
 */
export function resolveEnabledSkills(profileId?: number): ManagedArtifact[] {
	const filter = artifactFilter(profileId, 'skill');
	const source = filter
		? skillQueries.getAll().map(r => ({ slug: r.slug, name: r.name, description: r.description }))
		: getEnabledSkills();
	return source
		.filter(s => !filter || filter.has(s.slug))
		.map(s => ({
			slug: s.slug,
			name: s.name,
			description: s.description,
			sourceDir: getSkillDir(s.slug)
		}));
}

/**
 * Whether skills for this engine are delivered per-session via prompt injection
 * INSTEAD of the shared global memory file — true only for a synthetic (no native
 * dir) skill target on a prompt-scoped engine. Native skill engines
 * (Claude/Qwen/Copilot) keep the folder mirror+prune.
 */
function skillsViaPromptInjection(engine: SkillEngine): boolean {
	const synthetic = resolveArtifact('skill', { engine, scope: 'global' }).format === 'preamble-region';
	return synthetic && isPromptScopedEngine(engine);
}

/**
 * The profile-scoped skills preamble for PER-SESSION injection into a synthetic
 * engine's prompt (OpenCode/Codex). Returns '' when no skill applies. Uses the
 * exact wording of the old global block, so model behaviour is unchanged apart
 * from now being correctly scoped to the session's active Profile.
 */
export function buildSkillsPromptContext(profileId?: number): string {
	return buildSkillsPreamble(resolveEnabledSkills(profileId));
}

/**
 * Sync enabled skills for one engine. Safe to call at every stream start.
 * Never throws: failures are logged and swallowed so streaming is unaffected.
 *
 * NATIVE engines (Claude/Qwen/Copilot) mirror the profile-narrowed skill folders
 * into the engine's skills dir and prune the rest — a per-query-correct filter.
 *
 * SYNTHETIC engines (OpenCode/Codex) do NOT advertise skills through the shared
 * global memory file here: a single global file can't encode a per-session
 * profile choice and would leak across concurrent sessions (and their persistent
 * server may not re-read it). Instead they inject the resolved preamble into each
 * turn's prompt (see the adapters + {@link buildSkillsPromptContext}). We still
 * materialize an EMPTY set for them so any legacy `CLOPEN:SKILLS` block left in
 * AGENTS.md is stripped.
 */
export async function syncSkills(engine: SkillEngine, profileId?: number): Promise<void> {
	try {
		const viaPrompt = skillsViaPromptInjection(engine);
		const enabled: ManagedArtifact[] = viaPrompt ? [] : resolveEnabledSkills(profileId);
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

/** Re-sync every engine — used after a mutation so changes propagate eagerly. */
export async function syncSkillsAllEngines(): Promise<void> {
	const engines: SkillEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode'];
	await Promise.all(engines.map(syncSkills));
}

/** Validate that a skill's SKILL.md exists on disk (used by the WS status surface). */
export async function skillFileReady(slug: string): Promise<boolean> {
	return pathExists(getSkillMdPath(slug));
}
