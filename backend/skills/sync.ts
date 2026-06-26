/**
 * Engine sync — materialize enabled skills into the shape each engine consumes.
 *
 * Skills are an open standard, but engines surface them differently:
 *   - NATIVE (Claude, Copilot): read a real skills directory and do their own
 *     progressive disclosure. We mirror each enabled skill folder there.
 *   - SYNTHETIC (Codex, Qwen, OpenCode): have no skills concept, so we emit a
 *     "skills preamble" — name + description + the absolute path to each skill's
 *     SKILL.md — into a managed, marker-delimited block of the engine's global
 *     instructions file. The engine reads the body on demand with its own file
 *     tool, emulating progressive disclosure.
 *
 * Everything here writes ONLY inside Clopen's isolated per-engine home dirs
 * (never the user's real ~/.codex, ~/.qwen, …) and is wrapped so a sync failure
 * degrades gracefully — a stream never breaks because skills couldn't sync.
 *
 * NOTE: the synthetic target paths follow each engine's documented global-memory
 * convention but are best-effort; if an engine ignores the path, its skills
 * simply don't surface (no error, no data loss) until the mapping is verified
 * against that engine.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { skillQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { getSkillMdPath, copySkillInto } from './store';

export type SkillEngine = 'claude' | 'codex' | 'copilot' | 'qwen' | 'opencode';

const MARKER_START = '<!-- CLOPEN:SKILLS:START — managed block, do not edit -->';
const MARKER_END = '<!-- CLOPEN:SKILLS:END -->';

interface EnabledSkill {
	slug: string;
	name: string;
	description: string;
}

function getEnabledSkills(): EnabledSkill[] {
	return skillQueries.getEnabled().map(r => ({ slug: r.slug, name: r.name, description: r.description }));
}

/** Native engines read a real skills directory; this is where we mirror to. */
function nativeSkillsDir(engine: SkillEngine): string | null {
	switch (engine) {
		case 'claude': return join(getEngineUserConfigDir('claude'), 'skills');
		case 'copilot': return join(getEngineUserConfigDir('copilot'), 'skills');
		default: return null;
	}
}

/**
 * Synthetic engines have no skills dir — we inject the preamble into the global
 * instructions file each one auto-loads from its (isolated) home.
 */
function syntheticMemoryFile(engine: SkillEngine): string | null {
	switch (engine) {
		// Codex loads global guidance from `$CODEX_HOME/AGENTS.md`.
		case 'codex': return join(getEngineUserConfigDir('codex'), 'AGENTS.md');
		// Qwen (Gemini-CLI fork) loads context from a `QWEN.md` memory file.
		case 'qwen': return join(getEngineUserConfigDir('qwen'), 'QWEN.md');
		// OpenCode reads `AGENTS.md` from its XDG config dir (`$XDG_CONFIG_HOME/opencode`).
		case 'opencode': return join(getEngineUserConfigDir('opencode'), 'opencode', 'AGENTS.md');
		default: return null;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

/** Mirror enabled skill folders into a native engine's skills dir; prune the rest. */
async function syncNative(destDir: string, enabled: EnabledSkill[]): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const enabledSlugs = new Set(enabled.map(s => s.slug));
	const managedSlugs = new Set(skillQueries.getAll().map(s => s.slug));

	// Remove copies of managed skills that are no longer enabled. Folders we
	// don't manage (e.g. user-placed skills) are left untouched.
	for (const entry of await readdir(destDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (managedSlugs.has(entry.name) && !enabledSlugs.has(entry.name)) {
			await rm(join(destDir, entry.name), { recursive: true, force: true });
		}
	}

	for (const skill of enabled) {
		await copySkillInto(skill.slug, destDir);
	}
}

/** Build the synthetic preamble block listing each enabled skill. */
function buildPreamble(enabled: EnabledSkill[]): string {
	if (enabled.length === 0) return '';
	const lines: string[] = [
		MARKER_START,
		'# Available Skills',
		'',
		'You have access to the following skills. Each is a set of instructions for a',
		'specific kind of task. When the user\'s request matches a skill\'s purpose, READ',
		'its SKILL.md file with your file-reading tool to load the full instructions',
		'before proceeding. Only load a skill when it is relevant.',
		''
	];
	for (const skill of enabled) {
		lines.push(`- **${skill.name}** — ${skill.description}`);
		lines.push(`  Instructions: ${getSkillMdPath(skill.slug)}`);
	}
	lines.push(MARKER_END);
	return lines.join('\n');
}

/** Replace (or remove) the managed skills block inside an engine memory file. */
async function syncSynthetic(filePath: string, enabled: EnabledSkill[]): Promise<void> {
	let existing = '';
	if (await pathExists(filePath)) existing = await readFile(filePath, 'utf8');

	// Strip any prior managed block so updates are idempotent and never duplicate.
	const blockRe = new RegExp(`\\n*${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n*`, 'g');
	const base = existing.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n').trim();

	const block = buildPreamble(enabled);
	const next = block ? (base ? `${base}\n\n${block}\n` : `${block}\n`) : (base ? `${base}\n` : '');

	if (next === existing) return;
	if (next === '') {
		// Nothing managed and nothing else in the file — leave any empty file as-is.
		await writeFile(filePath, '', 'utf8');
		return;
	}
	await mkdir(join(filePath, '..'), { recursive: true });
	await writeFile(filePath, next, 'utf8');
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sync enabled skills for one engine. Safe to call at every stream start —
 * native dirs are reconciled and the synthetic block is rewritten in place.
 * Never throws: failures are logged and swallowed so streaming is unaffected.
 */
export async function syncSkills(engine: SkillEngine): Promise<void> {
	try {
		const enabled = getEnabledSkills();
		const native = nativeSkillsDir(engine);
		if (native) {
			await syncNative(native, enabled);
			debug.log('skills', `🧩 Synced ${enabled.length} skill(s) → ${engine} (native)`);
			return;
		}
		const memoryFile = syntheticMemoryFile(engine);
		if (memoryFile) {
			await syncSynthetic(memoryFile, enabled);
			debug.log('skills', `🧩 Synced ${enabled.length} skill(s) → ${engine} (synthetic)`);
		}
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
