/**
 * Edit in place — the only code that writes project artifacts into a repository.
 *
 * Every write lands in a location from {@link PROJECT_WRITE_PATHS}:
 *   - `.agents/skills/<slug>/SKILL.md`
 *   - `.agents/agents/<slug>.md`
 *   - `.agents/mcp.json`
 *   - root `AGENTS.md`, written exactly as edited
 *
 * Paths are built from the repo root plus a validated slug, never from a
 * caller-supplied path. The one caller-supplied path — the source of a "copy to
 * .agents" or a read — is confined to the repo root before use.
 */

import { join, resolve, sep, basename, isAbsolute } from 'path';
import { mkdir, readFile, writeFile, rm, rename, cp, stat, realpath, lstat } from 'node:fs/promises';
import { parseSkillMd, serializeSkillMd, type ParsedSkill } from '$backend/skills/spec';
import { debug } from '$shared/utils/logger';
import { parseDoc, serializeDoc } from '../frontmatter';
import { slugify, isValidSlug } from '../slug';
import { PROJECT_WRITE_PATHS } from './sources';
import { parseProjectMcpJson, hashContent, readSmallFile, subagentSlugFromFile } from './scan';

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch { return false; }
}

/**
 * Resolve a repo-relative path, refusing `..` segments and absolute paths.
 *
 * The path itself must sit in the repo; what it points AT may not — a skill
 * folder symlinked to a shared checkout is a normal setup, and the scan already
 * follows those links. Callers limit which files they open (see
 * {@link readProjectFile}).
 */
export async function resolveInsideRoot(root: string, relPath: string): Promise<string> {
	if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
		throw new Error(`Path must stay inside the project: ${relPath}`);
	}
	const abs = resolve(root, relPath);
	if (!abs.startsWith(resolve(root) + sep)) throw new Error(`Path must stay inside the project: ${relPath}`);
	if (!(await exists(abs))) throw new Error(`Not found: ${relPath}`);
	return abs;
}

/**
 * Read an artifact document the scan reported (skill `SKILL.md`, subagent,
 * instruction file, MCP config). Only Markdown/JSON/rule text is served, so a
 * committed symlink can't turn this into a general file reader.
 */
export async function readProjectFile(root: string, relPath: string): Promise<string> {
	let abs = await resolveInsideRoot(root, relPath);
	if ((await stat(abs)).isDirectory()) abs = join(abs, 'SKILL.md');
	if (!/\.(md|mdc|json|txt)$/i.test(abs) && basename(abs) !== '.clinerules') {
		throw new Error(`Not an artifact document: ${relPath}`);
	}
	const raw = await readSmallFile(abs);
	if (raw == null) throw new Error(`Cannot read ${relPath} (missing or larger than 512 KB)`);
	return raw;
}

function requireSlug(input: string): string {
	const slug = slugify(input);
	if (!isValidSlug(slug)) throw new Error(`"${input}" does not make a valid name (lowercase letters, digits, hyphens)`);
	return slug;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills — `.agents/skills/<slug>/SKILL.md`
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectSkillInput {
	/** Present when editing; a different `name` renames the folder. */
	originalSlug?: string;
	name: string;
	description: string;
	body: string;
}

export async function saveProjectSkill(root: string, input: ProjectSkillInput): Promise<{ slug: string; path: string }> {
	const slug = requireSlug(input.name);
	if (!input.description.trim()) throw new Error('A description is required — it is how the agent decides when to use the skill');
	const base = join(root, PROJECT_WRITE_PATHS.skills);
	const dir = join(base, slug);

	let existing: ParsedSkill | null = null;
	if (input.originalSlug) {
		if (!isValidSlug(input.originalSlug)) throw new Error('Invalid skill');
		const originalDir = join(base, input.originalSlug);
		const raw = await readSmallFile(join(originalDir, 'SKILL.md'));
		if (raw != null) { try { existing = parseSkillMd(raw); } catch { existing = null; } }
		if (input.originalSlug !== slug) {
			if (await exists(dir)) throw new Error(`A skill named "${slug}" already exists in ${PROJECT_WRITE_PATHS.skills}`);
			if (await exists(originalDir)) await rename(originalDir, dir);
		}
	} else if (await exists(dir)) {
		throw new Error(`A skill named "${slug}" already exists in ${PROJECT_WRITE_PATHS.skills}`);
	}

	// Keep every frontmatter field we don't edit here (license, allowed-tools,
	// metadata, …) so saving from Settings never strips what another tool wrote.
	const doc: ParsedSkill = {
		frontmatter: { ...(existing?.frontmatter ?? { extra: {} }), name: slug, description: input.description.trim() },
		body: input.body
	};
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'SKILL.md'), serializeSkillMd(doc), 'utf8');
	debug.log('artifacts', `📝 Project skill saved: ${join(PROJECT_WRITE_PATHS.skills, slug)}`);
	return { slug, path: `${PROJECT_WRITE_PATHS.skills}/${slug}` };
}

export async function deleteProjectSkill(root: string, slug: string): Promise<void> {
	if (!isValidSlug(slug)) throw new Error('Invalid skill');
	// `rm` on a symlinked folder removes the link, never the shared target.
	await rm(join(root, PROJECT_WRITE_PATHS.skills, slug), { recursive: true, force: true });
	debug.log('artifacts', `🗑️ Project skill deleted: ${slug}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subagents — `.agents/agents/<slug>.md`
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectSubagentInput {
	originalSlug?: string;
	name: string;
	description: string;
	tools?: string;
	model?: string;
	body: string;
}

export async function saveProjectSubagent(root: string, input: ProjectSubagentInput): Promise<{ slug: string; path: string }> {
	const slug = requireSlug(input.name);
	if (!input.description.trim()) throw new Error('A description is required — it is how the agent decides when to delegate');
	const base = join(root, PROJECT_WRITE_PATHS.subagents);
	const file = join(base, `${slug}.md`);

	let frontmatter: Record<string, string> = {};
	if (input.originalSlug) {
		if (!isValidSlug(input.originalSlug)) throw new Error('Invalid subagent');
		const originalFile = join(base, `${input.originalSlug}.md`);
		const raw = await readSmallFile(originalFile);
		if (raw != null) frontmatter = parseDoc(raw).frontmatter;
		if (input.originalSlug !== slug) {
			if (await exists(file)) throw new Error(`A subagent named "${slug}" already exists in ${PROJECT_WRITE_PATHS.subagents}`);
			await rm(originalFile, { force: true });
		}
	} else if (await exists(file)) {
		throw new Error(`A subagent named "${slug}" already exists in ${PROJECT_WRITE_PATHS.subagents}`);
	}

	const fm: Record<string, string> = { ...frontmatter, name: slug, description: input.description.trim() };
	const tools = input.tools?.split(/[\s,]+/).map(t => t.trim()).filter(Boolean).join(', ') ?? '';
	if (tools) fm.tools = tools; else delete fm.tools;
	if (input.model?.trim()) fm.model = input.model.trim(); else delete fm.model;

	await mkdir(base, { recursive: true });
	await writeFile(file, serializeDoc({ frontmatter: fm, body: input.body }, ['name', 'description', 'tools', 'model']), 'utf8');
	debug.log('artifacts', `📝 Project subagent saved: ${PROJECT_WRITE_PATHS.subagents}/${slug}.md`);
	return { slug, path: `${PROJECT_WRITE_PATHS.subagents}/${slug}.md` };
}

export async function deleteProjectSubagent(root: string, slug: string): Promise<void> {
	if (!isValidSlug(slug)) throw new Error('Invalid subagent');
	await rm(join(root, PROJECT_WRITE_PATHS.subagents, `${slug}.md`), { force: true });
	debug.log('artifacts', `🗑️ Project subagent deleted: ${slug}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy an artifact from another tool's folder into `.agents/`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copy (never move) a detected skill or subagent into `.agents/`, so the one
 * location every engine can use carries it. The original stays where it is —
 * another tool may still depend on it.
 */
export async function copyToAgents(root: string, kind: 'skill' | 'subagent', relPath: string): Promise<{ slug: string; path: string }> {
	const source = await resolveInsideRoot(root, relPath);
	if (kind === 'skill') {
		const slug = basename(source);
		if (!isValidSlug(slug)) throw new Error(`"${slug}" is not a valid skill folder name`);
		const dest = join(root, PROJECT_WRITE_PATHS.skills, slug);
		if (await exists(dest)) throw new Error(`${PROJECT_WRITE_PATHS.skills}/${slug} already exists`);
		await mkdir(join(root, PROJECT_WRITE_PATHS.skills), { recursive: true });
		await cp(await realpath(source), dest, { recursive: true });
		debug.log('artifacts', `📋 Copied ${relPath} → ${PROJECT_WRITE_PATHS.skills}/${slug}`);
		return { slug, path: `${PROJECT_WRITE_PATHS.skills}/${slug}` };
	}
	const slug = subagentSlugFromFile(basename(source));
	if (!slug || !isValidSlug(slug)) throw new Error(`"${basename(source)}" is not a valid subagent file name`);
	const dest = join(root, PROJECT_WRITE_PATHS.subagents, `${slug}.md`);
	if (await exists(dest)) throw new Error(`${PROJECT_WRITE_PATHS.subagents}/${slug}.md already exists`);
	await mkdir(join(root, PROJECT_WRITE_PATHS.subagents), { recursive: true });
	await writeFile(dest, await readFile(source, 'utf8'), 'utf8');
	debug.log('artifacts', `📋 Copied ${relPath} → ${PROJECT_WRITE_PATHS.subagents}/${slug}.md`);
	return { slug, path: `${PROJECT_WRITE_PATHS.subagents}/${slug}.md` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instructions — root `AGENTS.md`, verbatim
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentsMdState {
	exists: boolean;
	/** The file exactly as it is on disk. */
	content: string;
}

export async function readAgentsMd(root: string): Promise<AgentsMdState> {
	const raw = await readSmallFile(join(root, PROJECT_WRITE_PATHS.instructions));
	if (raw == null) return { exists: false, content: '' };
	return { exists: true, content: raw };
}

/** Write the file exactly as given — nothing added before or after. Empty content never creates the file. */
export async function saveAgentsMd(root: string, content: string): Promise<AgentsMdState> {
	const file = join(root, PROJECT_WRITE_PATHS.instructions);
	const current = await readAgentsMd(root);
	if (!current.exists && !content.trim()) return current;
	await writeFile(file, content, 'utf8');
	debug.log('artifacts', '📝 AGENTS.md saved');
	return readAgentsMd(root);
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP — `.agents/mcp.json`
// ─────────────────────────────────────────────────────────────────────────────

/** Validate and write `.agents/mcp.json`; returns the new content hash. */
export async function saveProjectMcp(root: string, raw: string): Promise<string> {
	const text = raw.trim() ? `${raw.trim()}\n` : '';
	const file = join(root, PROJECT_WRITE_PATHS.mcp);
	if (!text) {
		await rm(file, { force: true });
		return '';
	}
	parseProjectMcpJson(text); // throws a readable error for invalid config
	await mkdir(join(root, '.agents'), { recursive: true });
	await writeFile(file, text, 'utf8');
	debug.log('artifacts', '📝 .agents/mcp.json saved');
	return hashContent(text);
}
