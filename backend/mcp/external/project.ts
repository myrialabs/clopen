/**
 * Project MCP — servers a repository declares in `.agents/mcp.json`.
 *
 * They ride the same proxy as installed servers (Clopen is the upstream client,
 * engines only ever see a loopback bridge URL), on a project-addressed route:
 * `/mcp/proj/<projectId>/<name>`. Two things differ from installed servers:
 *
 *   - TRUST. The file lives in the repo, so anyone who can push to it could make
 *     the server run a command. A server is emitted — and the bridge will only
 *     connect it — while the file's current sha256 matches the hash an admin
 *     approved (`project_mcp_trust`). Any edit makes it inert until re-approved.
 *     The check runs at config-build time AND again when the bridge connects, so
 *     a file swapped between the two is still refused.
 *   - PLACE. stdio servers start with the repository as their working
 *     directory, which is what a repo-relative `command`/`args` expects.
 *
 * Namespace: `project-<name>`, so tools surface as `mcp__project-<name>__<tool>`
 * and never collide with an installed server of the same name.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'path';
import { projectQueries, projectMcpTrustQueries } from '$backend/database/queries';
import { parseProjectMcpJson, hashContent } from '$backend/artifacts/project/scan';
import { PROJECT_WRITE_PATHS } from '$backend/artifacts/project/sources';
import { slugify } from '$backend/artifacts/slug';
import { debug } from '$shared/utils/logger';
import type { ResolvedExternalServer } from './types';

export interface ResolvedProjectServer extends ResolvedExternalServer {
	projectId: string;
	/** Repository root — the working directory for stdio servers. */
	cwd: string;
}

/** Largest `.agents/mcp.json` Clopen will read. */
const MAX_BYTES = 256 * 1024;

/**
 * Namespaces of project servers emitted so far. Engines report MCP tools under
 * `<namespace><sep><tool>` with an SDK-specific separator, and the resolver has
 * no project context — so it matches against the namespaces actually handed out.
 */
const knownNamespaces = new Set<string>();

export function projectNamespace(name: string): string {
	return `project-${slugify(name)}`;
}

export function knownProjectNamespaces(): string[] {
	return [...knownNamespaces];
}

/** Expand `${VAR}` / `${VAR:-default}` from the server's environment, as `.mcp.json` does. */
function expand(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) =>
		process.env[name] ?? fallback ?? ''
	);
}

function expandRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
}

/** The raw file for a project, or null when absent/oversized. */
export function readProjectMcpFile(projectPath: string): string | null {
	const file = join(projectPath, PROJECT_WRITE_PATHS.mcp);
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > MAX_BYTES) return null;
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Every server in the project's `.agents/mcp.json`, but only while the file is
 * the approved version. Synchronous on purpose: the per-engine MCP builders it
 * feeds are synchronous, and the file is small.
 */
export function getTrustedProjectServers(projectId: string | null | undefined): ResolvedProjectServer[] {
	if (!projectId) return [];
	const project = projectQueries.getById(projectId);
	if (!project?.path) return [];
	const raw = readProjectMcpFile(project.path);
	if (raw == null) return [];
	if (!projectMcpTrustQueries.isTrusted(projectId, hashContent(raw))) {
		debug.log('mcp', `🔒 Project ${projectId}: .agents/mcp.json is not approved (or changed since) — not loading it`);
		return [];
	}
	let parsed;
	try {
		parsed = parseProjectMcpJson(raw);
	} catch (error) {
		debug.warn('mcp', `Project ${projectId}: .agents/mcp.json is invalid:`, error);
		return [];
	}
	return parsed.map(s => {
		const namespace = projectNamespace(s.name);
		knownNamespaces.add(namespace);
		return {
			id: 0,
			slug: s.name,
			namespace,
			name: s.name,
			transport: s.transport,
			command: s.command ? expand(s.command) : null,
			args: s.args.map(expand),
			env: expandRecord(s.env),
			url: s.url ? expand(s.url) : null,
			headers: expandRecord(s.headers),
			projectId,
			cwd: project.path
		};
	});
}

/** One trusted project server by name, or a readable error. */
export function requireTrustedProjectServer(projectId: string, name: string): ResolvedProjectServer {
	const server = getTrustedProjectServers(projectId).find(s => s.name === name);
	if (!server) throw new Error(`Project MCP server "${name}" is not declared in an approved .agents/mcp.json`);
	return server;
}
