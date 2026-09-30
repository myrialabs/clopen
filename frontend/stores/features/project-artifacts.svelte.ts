/**
 * Project Artifacts Store
 *
 * The "This project" side of Settings → Artifacts & Access: what the active
 * repository carries in `.agents/`, `.claude/`, `AGENTS.md` and friends, which
 * engines read each item (natively, through Clopen, or not at all), and the
 * in-place edits Clopen makes under `.agents/` and in the managed block of
 * `AGENTS.md`.
 *
 * `scope` is shared by every Artifacts & Access section, so switching sections
 * keeps the user on the scope they picked.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type ArtifactScope = 'global' | 'project';

/** Engine keys the backend reports coverage for (config-dir slugs). */
export type CoverageEngine = 'claude' | 'codex' | 'copilot' | 'qwen' | 'opencode' | 'pi' | 'cline' | 'cursor';
export type EngineCoverage = 'native' | 'bridged' | 'none';
export type CoverageMap = Record<string, string>;

export interface ProjectItem {
	kind: string;
	slug: string;
	name: string;
	description: string;
	sourceId: string;
	sourcePath: string;
	path: string;
	editable: boolean;
	shadowedBy: string | null;
	coverage: CoverageMap;
}

export interface ProjectInstructionFile {
	sourceId: string;
	path: string;
	fileCount: number | null;
	size: number;
	editable: boolean;
	note: string | null;
	coverage: CoverageMap;
}

export interface ProjectMcpServer {
	name: string;
	transport: string;
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
	error: string | null;
	hash: string;
	coverage: CoverageMap;
}

export interface ProjectScan {
	root: string;
	skills: ProjectItem[];
	subagents: ProjectItem[];
	instructions: ProjectInstructionFile[];
	mcp: ProjectMcpFile[];
	claudePermissions: { path: string; allow: string[]; deny: string[] }[];
	mcpTrust: { hash: string; approvedBy: string | null; approvedAt: string } | null;
}

export interface AgentsMdState {
	exists: boolean;
	content: string;
}

let scope = $state<ArtifactScope>('global');
let scan = $state<ProjectScan | null>(null);
let scanProjectId = $state<string | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);

export const projectArtifactsStore = {
	get scope() { return scope; },
	set scope(value: ArtifactScope) { scope = value; },
	get scan() { return scan; },
	get scanProjectId() { return scanProjectId; },
	get loading() { return loading; },
	get error() { return error; },

	async refresh(projectId: string): Promise<ProjectScan | null> {
		loading = true;
		error = null;
		try {
			const result = await ws.http('project-artifacts:scan', { projectId });
			scan = result as ProjectScan;
			scanProjectId = projectId;
			return scan;
		} catch (e) {
			debug.error('settings', 'Failed to scan project artifacts:', e);
			error = e instanceof Error ? e.message : 'Failed to read the project';
			return null;
		} finally {
			loading = false;
		}
	},

	/** Refresh unless the snapshot already belongs to this project. */
	async ensure(projectId: string): Promise<void> {
		if (scanProjectId !== projectId || !scan) await this.refresh(projectId);
	},

	async read(projectId: string, path: string): Promise<string> {
		const result = await ws.http('project-artifacts:read', { projectId, path });
		return result.content;
	},

	async saveSkill(projectId: string, input: { originalSlug?: string; name: string; description: string; body: string }) {
		const saved = await ws.http('project-artifacts:save-skill', { projectId, ...input });
		await this.refresh(projectId);
		return saved;
	},

	async deleteSkill(projectId: string, slug: string): Promise<void> {
		await ws.http('project-artifacts:delete-skill', { projectId, slug });
		await this.refresh(projectId);
	},

	async saveSubagent(projectId: string, input: { originalSlug?: string; name: string; description: string; tools?: string; model?: string; body: string }) {
		const saved = await ws.http('project-artifacts:save-subagent', { projectId, ...input });
		await this.refresh(projectId);
		return saved;
	},

	async deleteSubagent(projectId: string, slug: string): Promise<void> {
		await ws.http('project-artifacts:delete-subagent', { projectId, slug });
		await this.refresh(projectId);
	},

	async copyToAgents(projectId: string, kind: 'skill' | 'subagent', path: string) {
		const saved = await ws.http('project-artifacts:copy-to-agents', { projectId, kind, path });
		await this.refresh(projectId);
		return saved;
	},

	async getAgentsMd(projectId: string): Promise<AgentsMdState> {
		return ws.http('project-artifacts:get-agents-md', { projectId });
	},

	async saveAgentsMd(projectId: string, content: string): Promise<AgentsMdState> {
		const state = await ws.http('project-artifacts:save-agents-md', { projectId, content });
		await this.refresh(projectId);
		return state;
	},

	async getMcp(projectId: string): Promise<{ path: string; content: string }> {
		return ws.http('project-artifacts:get-mcp', { projectId });
	},

	async saveMcp(projectId: string, content: string): Promise<void> {
		await ws.http('project-artifacts:save-mcp', { projectId, content });
		await this.refresh(projectId);
	},

	async approveMcp(projectId: string, hash: string): Promise<void> {
		await ws.http('project-artifacts:approve-mcp', { projectId, hash });
		await this.refresh(projectId);
	},


	reset() {
		scan = null;
		scanProjectId = null;
		error = null;
	}
};

/**
 * Split a Markdown document into flat frontmatter + body — enough to prefill the
 * editors (the server re-serializes and keeps any keys not edited here).
 */
export function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw.replace(/^\uFEFF/, ''));
	if (!match) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (kv) frontmatter[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
	}
	return { frontmatter, body: (match[2] ?? '').replace(/^\r?\n/, '') };
}
