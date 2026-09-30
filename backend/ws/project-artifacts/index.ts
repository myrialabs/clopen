/**
 * Project Artifacts Router — the "This project" side of Settings → Artifacts &
 * Access: what the repository carries (`.agents/`, `.claude/`, `AGENTS.md`, …),
 * which engines read each item, and in-place edits.
 *
 * Every route resolves the repository from `projectId` server-side (never from
 * a client path) and reads the MAIN project checkout — worktrees follow it once
 * the change is committed and merged. Writes go only to `.agents/` and the
 * managed block of `AGENTS.md` (see `backend/artifacts/project/edit.ts`).
 * Admin-only: see ADMIN_ONLY_ROUTES.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { requireProjectAccess } from '../access';
import { projectMcpTrustQueries } from '$backend/database/queries';
import {
	scanProject,
	readProjectFile,
	saveProjectSkill,
	deleteProjectSkill,
	saveProjectSubagent,
	deleteProjectSubagent,
	copyToAgents,
	readAgentsMd,
	saveAgentsMd,
	saveProjectMcp,
	hashContent,
	PROJECT_WRITE_PATHS
} from '$backend/artifacts/project';
import { readProjectMcpFile } from '$backend/mcp';

const COVERAGE = t.Record(t.String(), t.String());

const ITEM = t.Object({
	kind: t.String(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	sourceId: t.String(),
	sourcePath: t.String(),
	path: t.String(),
	editable: t.Boolean(),
	shadowedBy: t.Union([t.String(), t.Null()]),
	coverage: COVERAGE
});

const SCAN = t.Object({
	root: t.String(),
	skills: t.Array(ITEM),
	subagents: t.Array(ITEM),
	instructions: t.Array(t.Object({
		sourceId: t.String(),
		path: t.String(),
		fileCount: t.Union([t.Number(), t.Null()]),
		size: t.Number(),
		editable: t.Boolean(),
		note: t.Union([t.String(), t.Null()]),
		coverage: COVERAGE
	})),
	mcp: t.Array(t.Object({
		sourceId: t.String(),
		path: t.String(),
		editable: t.Boolean(),
		servers: t.Array(t.Object({
			name: t.String(),
			transport: t.String(),
			command: t.Union([t.String(), t.Null()]),
			args: t.Array(t.String()),
			env: t.Record(t.String(), t.String()),
			url: t.Union([t.String(), t.Null()]),
			headers: t.Record(t.String(), t.String())
		})),
		error: t.Union([t.String(), t.Null()]),
		hash: t.String(),
		coverage: COVERAGE
	})),
	claudePermissions: t.Array(t.Object({ path: t.String(), allow: t.Array(t.String()), deny: t.Array(t.String()) })),
	mcpTrust: t.Union([t.Object({ hash: t.String(), approvedBy: t.Union([t.String(), t.Null()]), approvedAt: t.String() }), t.Null()])
});

const SAVED = t.Object({ slug: t.String(), path: t.String() });

const AGENTS_MD = t.Object({ exists: t.Boolean(), content: t.String() });

/** Project row + repository root for a request, with the caller's access checked. */
function projectRoot(conn: WSConnection, projectId: string): { root: string; projectId: string } {
	const project = requireProjectAccess(conn, projectId);
	if (!project.path) throw new Error('Project has no path on disk');
	return { root: project.path, projectId };
}

async function scanFor(conn: WSConnection, projectId: string) {
	const { root } = projectRoot(conn, projectId);
	const scan = await scanProject(root, hash => projectMcpTrustQueries.isTrusted(projectId, hash));
	const trust = projectMcpTrustQueries.get(projectId);
	return {
		...scan,
		mcpTrust: trust ? { hash: trust.file_hash, approvedBy: trust.approved_by, approvedAt: trust.approved_at } : null
	};
}

export const projectArtifactsRouter = createRouter()
	.http('project-artifacts:scan', {
		data: t.Object({ projectId: t.String() }),
		response: SCAN
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:scan ${data.projectId}`);
		return scanFor(conn, data.projectId);
	})

	.http('project-artifacts:read', {
		data: t.Object({ projectId: t.String(), path: t.String() }),
		response: t.Object({ content: t.String() })
	}, async ({ data, conn }) => {
		const { root } = projectRoot(conn, data.projectId);
		return { content: await readProjectFile(root, data.path) };
	})

	// ── Skills: .agents/skills/<slug>/SKILL.md ─────────────────────────────────
	.http('project-artifacts:save-skill', {
		data: t.Object({
			projectId: t.String(),
			originalSlug: t.Optional(t.String()),
			name: t.String(),
			description: t.String(),
			body: t.String()
		}),
		response: SAVED
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:save-skill ${data.projectId} ${data.name}`);
		const { root } = projectRoot(conn, data.projectId);
		return saveProjectSkill(root, data);
	})
	.http('project-artifacts:delete-skill', {
		data: t.Object({ projectId: t.String(), slug: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:delete-skill ${data.projectId} ${data.slug}`);
		const { root } = projectRoot(conn, data.projectId);
		await deleteProjectSkill(root, data.slug);
		return { success: true };
	})

	// ── Subagents: .agents/agents/<slug>.md ────────────────────────────────────
	.http('project-artifacts:save-subagent', {
		data: t.Object({
			projectId: t.String(),
			originalSlug: t.Optional(t.String()),
			name: t.String(),
			description: t.String(),
			tools: t.Optional(t.String()),
			model: t.Optional(t.String()),
			body: t.String()
		}),
		response: SAVED
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:save-subagent ${data.projectId} ${data.name}`);
		const { root } = projectRoot(conn, data.projectId);
		return saveProjectSubagent(root, data);
	})
	.http('project-artifacts:delete-subagent', {
		data: t.Object({ projectId: t.String(), slug: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:delete-subagent ${data.projectId} ${data.slug}`);
		const { root } = projectRoot(conn, data.projectId);
		await deleteProjectSubagent(root, data.slug);
		return { success: true };
	})

	.http('project-artifacts:copy-to-agents', {
		data: t.Object({ projectId: t.String(), kind: t.Union([t.Literal('skill'), t.Literal('subagent')]), path: t.String() }),
		response: SAVED
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:copy-to-agents ${data.projectId} ${data.path}`);
		const { root } = projectRoot(conn, data.projectId);
		return copyToAgents(root, data.kind, data.path);
	})

	// ── Instructions: AGENTS.md ───────────────────────────────
	.http('project-artifacts:get-agents-md', {
		data: t.Object({ projectId: t.String() }),
		response: AGENTS_MD
	}, async ({ data, conn }) => {
		const { root } = projectRoot(conn, data.projectId);
		return readAgentsMd(root);
	})
	.http('project-artifacts:save-agents-md', {
		data: t.Object({ projectId: t.String(), content: t.String() }),
		response: AGENTS_MD
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:save-agents-md ${data.projectId}`);
		const { root } = projectRoot(conn, data.projectId);
		return saveAgentsMd(root, data.content);
	})

	// ── MCP: .agents/mcp.json + trust gate ─────────────────────────────────────
	.http('project-artifacts:get-mcp', {
		data: t.Object({ projectId: t.String() }),
		response: t.Object({ path: t.String(), content: t.String() })
	}, async ({ data, conn }) => {
		const { root } = projectRoot(conn, data.projectId);
		return { path: PROJECT_WRITE_PATHS.mcp, content: readProjectMcpFile(root) ?? '' };
	})
	.http('project-artifacts:save-mcp', {
		data: t.Object({ projectId: t.String(), content: t.String() }),
		response: t.Object({ hash: t.String() })
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:save-mcp ${data.projectId}`);
		const { root, projectId } = projectRoot(conn, data.projectId);
		const hash = await saveProjectMcp(root, data.content);
		// An admin writing the file from Settings IS the approval: they authored
		// exactly this content. Edits from anywhere else still need approving.
		if (hash) projectMcpTrustQueries.approve(projectId, hash, ws.getUserId(conn));
		else projectMcpTrustQueries.revoke(projectId);
		return { hash };
	})
	.http('project-artifacts:approve-mcp', {
		data: t.Object({ projectId: t.String(), hash: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		debug.log('path', `project-artifacts:approve-mcp ${data.projectId}`);
		const { root, projectId } = projectRoot(conn, data.projectId);
		const raw = readProjectMcpFile(root);
		// Approve only what the admin actually reviewed: the hash they saw must
		// still be the file on disk.
		if (raw == null || hashContent(raw) !== data.hash) {
			throw new Error('.agents/mcp.json changed since it was shown — review it again before approving');
		}
		projectMcpTrustQueries.approve(projectId, data.hash, ws.getUserId(conn));
		return { success: true };
	});
