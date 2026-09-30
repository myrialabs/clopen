/**
 * Project scanner — reads what a repository actually carries in every location
 * of {@link PROJECT_SOURCES} and works out, per engine, whether each artifact
 * reaches that engine natively, through Clopen's bridge, or not at all.
 *
 * The coverage rules live here and nowhere else: the Settings badges and the
 * per-stream bridge both call {@link scanProject}, so what the UI claims is the
 * same computation that decides what gets delivered.
 *
 * Read-only. Never throws for a missing or malformed file — an unreadable entry
 * is skipped, a broken frontmatter falls back to the file name.
 */

import { join, relative, sep } from 'path';
import { readdir, readFile, stat, lstat, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSkillMd } from '$backend/skills/spec';
import { ARTIFACT_ENGINES, type ArtifactEngine } from '../types';
import { canDelegateSubagents } from '../matrix';
import { parseDoc } from '../frontmatter';
import { PROJECT_SOURCES, sourcesOf, type ProjectSource } from './sources';

export type EngineCoverage = 'native' | 'bridged' | 'none';
export type CoverageMap = Record<ArtifactEngine, EngineCoverage>;

/** A skill or subagent found in the repository. */
export interface ProjectItem {
	kind: 'skill' | 'subagent';
	slug: string;
	name: string;
	description: string;
	sourceId: string;
	/** Source directory, relative to the repo root. */
	sourcePath: string;
	/** The item itself (skill folder or `.md` file), relative to the repo root. */
	path: string;
	/** Absolute path of the entry file (`SKILL.md` or the subagent `.md`). */
	entryFile: string;
	editable: boolean;
	/** Set when a higher-priority source already carries the same slug. */
	shadowedBy: string | null;
	coverage: CoverageMap;
}

export interface ProjectInstructionFile {
	sourceId: string;
	path: string;
	/** `md-dir` sources report how many rule files they hold. */
	fileCount: number | null;
	size: number;
	editable: boolean;
	/** Human note on a coverage special case (e.g. CLAUDE.md importing AGENTS.md). */
	note: string | null;
	coverage: CoverageMap;
}

export interface ProjectMcpServer {
	name: string;
	transport: 'stdio' | 'http' | 'sse';
	command: string | null;
	args: string[];
	env: Record<string, string>;
	url: string | null;
	headers: Record<string, string>;
}

export interface ProjectMcpFile {
	sourceId: string;
	path: string;
	editable: boolean;
	servers: ProjectMcpServer[];
	/** Parse error, shown raw. */
	error: string | null;
	/** sha256 of the file bytes — the identity the trust gate approves. */
	hash: string;
	coverage: CoverageMap;
}

export interface ProjectPermissionsFile {
	path: string;
	allow: string[];
	deny: string[];
}

export interface ProjectScan {
	root: string;
	skills: ProjectItem[];
	subagents: ProjectItem[];
	instructions: ProjectInstructionFile[];
	mcp: ProjectMcpFile[];
	/** `.claude/settings*.json` permission rules Claude applies on its own. */
	claudePermissions: ProjectPermissionsFile[];
}

/** Largest file the scanner will read. Artifacts are prose; anything bigger is not one. */
const MAX_READ_BYTES = 512 * 1024;

async function isDir(path: string): Promise<boolean> {
	try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function fileSize(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}

export async function readSmallFile(path: string): Promise<string | null> {
	const size = await fileSize(path);
	if (size == null || size > MAX_READ_BYTES) return null;
	try { return await readFile(path, 'utf8'); } catch { return null; }
}

export function hashContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function rel(root: string, path: string): string {
	return relative(root, path).split(sep).join('/');
}

function emptyCoverage(): CoverageMap {
	return Object.fromEntries(ARTIFACT_ENGINES.map(e => [e, 'none'])) as CoverageMap;
}

/** Name + description of a skill folder, tolerant of frontmatter the strict parser rejects. */
async function readSkillMeta(skillMd: string, slug: string): Promise<{ name: string; description: string } | null> {
	const raw = await readSmallFile(skillMd);
	if (raw == null) return null;
	try {
		const { frontmatter } = parseSkillMd(raw);
		return { name: frontmatter.name || slug, description: frontmatter.description || '' };
	} catch {
		const { frontmatter } = parseDoc(raw);
		return { name: frontmatter.name || slug, description: frontmatter.description || '' };
	}
}

/** Strip the extensions a subagent file may carry (`.agent.md` is Copilot's). */
export function subagentSlugFromFile(fileName: string): string | null {
	if (!fileName.endsWith('.md')) return null;
	return fileName.replace(/\.agent\.md$/, '').replace(/\.md$/, '');
}

async function scanSource(root: string, source: ProjectSource): Promise<Omit<ProjectItem, 'shadowedBy' | 'coverage'>[]> {
	const dir = join(root, source.path);
	if (!(await isDir(dir))) return [];
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
	const out: Omit<ProjectItem, 'shadowedBy' | 'coverage'>[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith('.')) continue;
		const itemPath = join(dir, entry.name);
		if (source.layout === 'skill-dirs') {
			// Symlinked skill folders are common (one copy shared between tools).
			if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDir(itemPath)))) continue;
			const entryFile = join(itemPath, 'SKILL.md');
			const meta = await readSkillMeta(entryFile, entry.name);
			if (!meta) continue;
			out.push({
				kind: 'skill', slug: entry.name, ...meta,
				sourceId: source.id, sourcePath: source.path, path: rel(root, itemPath), entryFile,
				editable: !!source.editable
			});
		} else if (source.layout === 'md-files') {
			const slug = subagentSlugFromFile(entry.name);
			if (!slug || entry.isDirectory()) continue;
			const raw = await readSmallFile(itemPath);
			if (raw == null) continue;
			const { frontmatter } = parseDoc(raw);
			out.push({
				kind: 'subagent', slug, name: frontmatter.name || slug, description: frontmatter.description || '',
				sourceId: source.id, sourcePath: source.path, path: rel(root, itemPath), entryFile: itemPath,
				editable: !!source.editable
			});
		}
	}
	return out;
}

/** Whether `engine` can receive a bridged artifact of this kind at all. */
function canBridge(kind: 'skill' | 'subagent', engine: ArtifactEngine): boolean {
	// Every engine can be told about a skill (natively, by plugin, or in its
	// prompt). Subagents need a real delegation surface; engines without one are
	// never told a subagent exists — same rule as the global Subagents feature.
	return kind === 'skill' || canDelegateSubagents(engine);
}

/**
 * Resolve coverage for every item of one kind. An engine sees a slug natively
 * when ANY source it reads carries that slug; otherwise the highest-priority
 * copy (source order in {@link PROJECT_SOURCES}) is the one Clopen bridges.
 */
function resolveItems(kind: 'skill' | 'subagent', raw: Omit<ProjectItem, 'shadowedBy' | 'coverage'>[]): ProjectItem[] {
	const sources = sourcesOf(kind);
	const nativeBySource = new Map(sources.map(s => [s.id, s.native]));
	const winner = new Map<string, string>();
	for (const item of raw) if (!winner.has(item.slug)) winner.set(item.slug, item.sourceId);

	return raw.map(item => {
		const coverage = emptyCoverage();
		for (const engine of ARTIFACT_ENGINES) {
			if (nativeBySource.get(item.sourceId)?.includes(engine)) {
				coverage[engine] = 'native';
				continue;
			}
			const seenNatively = raw.some(o => o.slug === item.slug && nativeBySource.get(o.sourceId)?.includes(engine));
			if (seenNatively) continue; // another copy reaches it natively; this one is redundant there
			if (winner.get(item.slug) === item.sourceId && canBridge(kind, engine)) coverage[engine] = 'bridged';
		}
		const top = winner.get(item.slug);
		return { ...item, shadowedBy: top && top !== item.sourceId ? top : null, coverage };
	});
}

/** True when `CLAUDE.md` pulls `AGENTS.md` in (symlink or an `@AGENTS.md` import line). */
async function claudeMdIncludesAgentsMd(root: string): Promise<boolean> {
	const claudeMd = join(root, 'CLAUDE.md');
	try {
		if ((await lstat(claudeMd)).isSymbolicLink()) {
			const target = await readlink(claudeMd);
			if (target.replace(/^\.\//, '') === 'AGENTS.md') return true;
			if ((await realpath(claudeMd)) === (await realpath(join(root, 'AGENTS.md')))) return true;
		}
	} catch { /* missing */ }
	const raw = await readSmallFile(claudeMd);
	return raw != null && /^\s*@\.?\/?AGENTS\.md\s*$/m.test(raw);
}

async function scanInstructions(root: string): Promise<ProjectInstructionFile[]> {
	const out: ProjectInstructionFile[] = [];
	const agentsMdExists = (await fileSize(join(root, 'AGENTS.md'))) != null;
	const claudeImports = agentsMdExists && (await claudeMdIncludesAgentsMd(root));

	for (const source of sourcesOf('instruction')) {
		const abs = join(root, source.path);
		let size: number | null = null;
		let fileCount: number | null = null;
		if (source.layout === 'md-dir' || (source.id === 'clinerules' && (await isDir(abs)))) {
			if (!(await isDir(abs))) continue;
			try {
				const files = (await readdir(abs, { withFileTypes: true })).filter(e => e.isFile() && /\.(md|mdc|txt)$/.test(e.name));
				fileCount = files.length;
				size = 0;
			} catch { continue; }
		} else {
			size = await fileSize(abs);
			if (size == null) continue;
		}

		const coverage = emptyCoverage();
		for (const engine of source.native) coverage[engine] = 'native';
		let note: string | null = null;
		if (source.id === 'agents-md') {
			// Engines that don't read AGENTS.md get it from Clopen: Claude (unless
			// CLAUDE.md already imports it), and Cline/Cursor which read no repo file.
			if (claudeImports) {
				coverage.claude = 'native';
				note = 'Claude reads it through CLAUDE.md';
			}
			for (const engine of ARTIFACT_ENGINES) if (coverage[engine] === 'none') coverage[engine] = 'bridged';
		}
		if (source.id === 'claude-md' && !agentsMdExists) {
			// Pi loads AGENTS.md, and falls back to CLAUDE.md when there is none.
			coverage.pi = 'native';
		}
		out.push({ sourceId: source.id, path: source.path, fileCount, size: size ?? 0, editable: !!source.editable, note, coverage });
	}
	return out;
}

function asStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
	return out;
}

/**
 * Parse an `.mcp.json`-shaped document: `{ "mcpServers": { name: config } }`.
 * Accepts the bare map too. Throws a readable error for anything else.
 */
export function parseProjectMcpJson(raw: string): ProjectMcpServer[] {
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object with an "mcpServers" map');
	const map = ((parsed as Record<string, unknown>).mcpServers ?? parsed) as Record<string, unknown>;
	if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('"mcpServers" must be an object');
	const servers: ProjectMcpServer[] = [];
	for (const [name, value] of Object.entries(map)) {
		if (!value || typeof value !== 'object') throw new Error(`Server "${name}" must be an object`);
		const cfg = value as Record<string, unknown>;
		const url = typeof cfg.url === 'string' ? cfg.url : null;
		const command = typeof cfg.command === 'string' ? cfg.command : null;
		const declared = typeof cfg.type === 'string' ? cfg.type : null;
		const transport = declared === 'sse' ? 'sse' : declared === 'http' || declared === 'streamable-http' ? 'http' : url ? 'http' : 'stdio';
		if (transport === 'stdio' && !command) throw new Error(`Server "${name}" needs a "command" (stdio) or a "url" (http/sse)`);
		if (transport !== 'stdio' && !url) throw new Error(`Server "${name}" is ${transport} but has no "url"`);
		servers.push({
			name,
			transport,
			command: transport === 'stdio' ? command : null,
			args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
			env: asStringRecord(cfg.env),
			url: transport === 'stdio' ? null : url,
			headers: asStringRecord(cfg.headers)
		});
	}
	return servers;
}

async function scanMcp(root: string, isTrusted: (hash: string) => boolean): Promise<ProjectMcpFile[]> {
	const out: ProjectMcpFile[] = [];
	for (const source of sourcesOf('mcp')) {
		const raw = await readSmallFile(join(root, source.path));
		if (raw == null) continue;
		let servers: ProjectMcpServer[] = [];
		let error: string | null = null;
		try { servers = parseProjectMcpJson(raw); } catch (e) { error = e instanceof Error ? e.message : String(e); }
		const hash = hashContent(raw);
		const coverage = emptyCoverage();
		for (const engine of source.native) coverage[engine] = 'native';
		if (source.editable && !error && servers.length > 0 && isTrusted(hash)) {
			for (const engine of ARTIFACT_ENGINES) if (coverage[engine] === 'none') coverage[engine] = 'bridged';
		}
		out.push({ sourceId: source.id, path: source.path, editable: !!source.editable, servers, error, hash, coverage });
	}
	return out;
}

async function scanClaudePermissions(root: string): Promise<ProjectPermissionsFile[]> {
	const out: ProjectPermissionsFile[] = [];
	for (const path of ['.claude/settings.json', '.claude/settings.local.json']) {
		const raw = await readSmallFile(join(root, path));
		if (raw == null) continue;
		try {
			const perms = (JSON.parse(raw) as { permissions?: { allow?: unknown; deny?: unknown } }).permissions;
			const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
			const allow = list(perms?.allow);
			const deny = list(perms?.deny);
			if (allow.length || deny.length) out.push({ path, allow, deny });
		} catch { /* not JSON — Claude would reject it too */ }
	}
	return out;
}

/**
 * Scan one repository root. `isMcpTrusted` answers whether a given
 * `.agents/mcp.json` hash has been approved for the project (the scan itself has
 * no database access, so it stays usable from tests and the bridge alike).
 */
export async function scanProject(root: string, isMcpTrusted: (hash: string) => boolean = () => false): Promise<ProjectScan> {
	const collect = async (kind: 'skill' | 'subagent') => {
		const raw: Omit<ProjectItem, 'shadowedBy' | 'coverage'>[] = [];
		for (const source of PROJECT_SOURCES.filter(s => s.kind === kind)) raw.push(...(await scanSource(root, source)));
		return resolveItems(kind, raw);
	};
	const [skills, subagents, instructions, mcp, claudePermissions] = await Promise.all([
		collect('skill'),
		collect('subagent'),
		scanInstructions(root),
		scanMcp(root, isMcpTrusted),
		scanClaudePermissions(root)
	]);
	return { root, skills, subagents, instructions, mcp, claudePermissions };
}
