/**
 * Project bridge — per stream, delivers the repository's artifacts to an engine
 * that does not read them on its own.
 *
 * What gets bridged comes straight from {@link scanProject}'s coverage: an item
 * marked `bridged` for this engine. Everything is delivered through per-query
 * channels only — prompt text, SDK options, a Clopen-owned plugin dir — and
 * NEVER by writing into the repository or into an engine's shared global dir.
 * Two sessions on two projects therefore can't see each other's artifacts, and
 * the working tree never changes because a chat started.
 *
 * Instructions have two project layers:
 *   - `AGENTS.md` (committed, shared with every tool) — bridged to the engines
 *     that don't read it: Claude (unless `CLAUDE.md` imports it), Cline, Cursor.
 *   - The Clopen-only block (Settings → Instructions → This project, stored in
 *     the database, never committed) — delivered to every engine.
 *
 * Never throws: a repo Clopen can't read yields an empty bridge.
 */

import { join } from 'path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { instructionQueries } from '$backend/database/queries';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import type { ArtifactEngine } from '../types';
import { parseDoc } from '../frontmatter';
import { mirrorFolder } from '../sync';
import { scanProject, readSmallFile, type ProjectItem } from './scan';

export interface BridgedSkill {
	slug: string;
	name: string;
	description: string;
	/** Absolute skill folder. */
	dir: string;
	/** Absolute `SKILL.md`. */
	skillMd: string;
	/** Where it lives in the repo, for the preamble. */
	path: string;
}

export interface BridgedSubagent {
	slug: string;
	name: string;
	description: string;
	/** The subagent's instructions (document body). */
	prompt: string;
	tools?: string[];
	model?: string;
	path: string;
}

export interface ProjectBridge {
	engine: ArtifactEngine;
	root: string;
	skills: BridgedSkill[];
	subagents: BridgedSubagent[];
	/** `AGENTS.md` content, when this engine doesn't read the file itself. */
	agentsMd: string | null;
	/** The Clopen-only project instruction block (database layer). */
	clopenInstructions: string | null;
}

/** Cap on bridged `AGENTS.md` so a huge file can't swamp every prompt. */
const MAX_AGENTS_MD_CHARS = 64 * 1024;

export function emptyBridge(engine: ArtifactEngine, root = ''): ProjectBridge {
	return { engine, root, skills: [], subagents: [], agentsMd: null, clopenInstructions: null };
}

function splitList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const list = value.replace(/^\[|\]$/g, '').split(/[\s,]+/).map(t => t.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
	return list.length ? list : undefined;
}

async function toSubagent(item: ProjectItem): Promise<BridgedSubagent | null> {
	const raw = await readSmallFile(item.entryFile);
	if (raw == null) return null;
	const { frontmatter, body } = parseDoc(raw);
	return {
		slug: item.slug,
		name: item.name,
		description: item.description,
		prompt: body.trim() || `You are the ${item.name} subagent. ${item.description}`,
		tools: splitList(frontmatter.tools),
		model: frontmatter.model || undefined,
		path: item.path
	};
}

/**
 * Resolve what Clopen must deliver to `engine` for the repository at `root`.
 * `projectId` adds the Clopen-only instruction layer; omit it for a bare path.
 */
export async function resolveProjectBridge(engine: ArtifactEngine, root: string, projectId?: string | null): Promise<ProjectBridge> {
	const bridge = emptyBridge(engine, root);
	try {
		if (projectId) {
			const row = instructionQueries.getForProject(projectId);
			const content = row && row.is_enabled === 1 ? row.content.trim() : '';
			bridge.clopenInstructions = content || null;
		}
		if (!root) return bridge;

		const scan = await scanProject(root);
		bridge.skills = scan.skills
			.filter(i => i.coverage[engine] === 'bridged')
			.map(i => ({ slug: i.slug, name: i.name, description: i.description, dir: join(root, i.path), skillMd: i.entryFile, path: i.path }));
		for (const item of scan.subagents.filter(i => i.coverage[engine] === 'bridged')) {
			const sub = await toSubagent(item);
			if (sub) bridge.subagents.push(sub);
		}
		const agentsMd = scan.instructions.find(f => f.sourceId === 'agents-md');
		if (agentsMd?.coverage[engine] === 'bridged') {
			const content = (await readSmallFile(join(root, 'AGENTS.md')))?.trim();
			if (content) {
				bridge.agentsMd = content.length > MAX_AGENTS_MD_CHARS
					? `${content.slice(0, MAX_AGENTS_MD_CHARS)}\n\n[AGENTS.md truncated — read the file for the rest]`
					: content;
			}
		}
	} catch (error) {
		debug.warn('artifacts', `⚠️ Project bridge for ${engine} at ${root} failed (continuing without):`, error);
	}
	return bridge;
}

export interface PromptContextParts {
	skills?: boolean;
	subagents?: boolean;
	instructions?: boolean;
}

/**
 * The bridged artifacts as prompt text — for engines whose only per-session
 * channel is the prompt (or an appended system prompt). Choose the parts the
 * engine can't receive through a better channel. Returns '' when empty.
 */
export function buildProjectPromptContext(bridge: ProjectBridge, parts: PromptContextParts = { skills: true, subagents: true, instructions: true }): string {
	const sections: string[] = [];
	if (parts.instructions && bridge.agentsMd) {
		sections.push(['# Project Instructions (AGENTS.md)', '', 'Standing instructions from this repository\'s AGENTS.md:', '', bridge.agentsMd].join('\n'));
	}
	if (parts.instructions && bridge.clopenInstructions) {
		sections.push(['# Project Instructions', '', 'Always-on directives for this project:', '', bridge.clopenInstructions].join('\n'));
	}
	if (parts.skills && bridge.skills.length > 0) {
		const lines = [
			'# Project Skills',
			'',
			'This repository provides the following skills. When the user\'s request matches a',
			'skill\'s purpose, READ its SKILL.md with your file-reading tool before proceeding.',
			'Only load a skill when it is relevant.',
			''
		];
		for (const skill of bridge.skills) {
			lines.push(`- **${skill.name}** — ${skill.description}`);
			lines.push(`  Instructions: ${skill.skillMd}`);
		}
		sections.push(lines.join('\n'));
	}
	if (parts.subagents && bridge.subagents.length > 0) {
		const lines = ['# Project Subagents', '', 'Specialized agents from this repository you can delegate matching tasks to:', ''];
		for (const s of bridge.subagents) lines.push(`- **${s.name}** (${s.slug}) — ${s.description}`);
		sections.push(lines.join('\n'));
	}
	return sections.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude — skills through a Clopen-owned local plugin
// ─────────────────────────────────────────────────────────────────────────────

/** Plugin name Claude namespaces bridged skills under (`project:<skill>`). */
const CLAUDE_PLUGIN_NAME = 'project';

/**
 * Materialize the bridged skills as a local Claude plugin OUTSIDE the repo and
 * return its path, or null when there is nothing to bridge.
 *
 * A plugin is the only per-query way to hand Claude extra skills: its native
 * `skills/` dirs are either the repo (must not be written) or the isolated
 * config dir (shared by every concurrent session, so one project's skills would
 * leak into another's). Skill folders are COPIED, not symlinked — Claude skips
 * symlinked project entries for safety — and re-copied only when changed
 * (same freshness check the global skill mirror uses).
 */
export async function ensureClaudeProjectPlugin(bridge: ProjectBridge): Promise<string | null> {
	if (bridge.skills.length === 0) return null;
	try {
		const key = createHash('sha1').update(bridge.root).digest('hex').slice(0, 16);
		const pluginDir = join(getClopenDir(), 'project-bridge', 'claude', key);
		const manifestDir = join(pluginDir, '.claude-plugin');
		const skillsDir = join(pluginDir, 'skills');
		await mkdir(manifestDir, { recursive: true });
		await mkdir(skillsDir, { recursive: true });

		const manifest = `${JSON.stringify({ name: CLAUDE_PLUGIN_NAME, description: `Skills from ${bridge.root}`, version: '1.0.0' }, null, 2)}\n`;
		const manifestPath = join(manifestDir, 'plugin.json');
		if ((await readFile(manifestPath, 'utf8').catch(() => '')) !== manifest) await writeFile(manifestPath, manifest, 'utf8');

		const wanted = new Set(bridge.skills.map(s => s.slug));
		for (const entry of await readdir(skillsDir)) {
			if (!wanted.has(entry)) await rm(join(skillsDir, entry), { recursive: true, force: true });
		}
		for (const skill of bridge.skills) {
			// Resolve a symlinked skill folder first so the copy holds real files.
			await mirrorFolder(await realpath(skill.dir), skillsDir, skill.slug);
		}
		return pluginDir;
	} catch (error) {
		debug.warn('artifacts', '⚠️ Could not build the Claude project-skills plugin (continuing without):', error);
		return null;
	}
}
