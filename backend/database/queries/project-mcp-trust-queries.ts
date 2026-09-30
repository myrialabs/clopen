/**
 * Project MCP trust — which version of a repository's `.agents/mcp.json` an
 * admin approved. Approval is keyed by the file's sha256 (see migration 083), so
 * a changed file is simply "not the approved one" until re-approved.
 */

import { getDatabase } from '../index';

export interface ProjectMcpTrustRow {
	project_id: string;
	file_hash: string;
	approved_by: string | null;
	approved_at: string;
}

export const projectMcpTrustQueries = {
	get(projectId: string): ProjectMcpTrustRow | null {
		return getDatabase()
			.prepare('SELECT * FROM project_mcp_trust WHERE project_id = ?')
			.get(projectId) as ProjectMcpTrustRow | null;
	},

	isTrusted(projectId: string, fileHash: string): boolean {
		return this.get(projectId)?.file_hash === fileHash;
	},

	approve(projectId: string, fileHash: string, approvedBy: string | null): void {
		getDatabase()
			.prepare(`
				INSERT INTO project_mcp_trust (project_id, file_hash, approved_by, approved_at)
				VALUES (?, ?, ?, datetime('now'))
				ON CONFLICT(project_id) DO UPDATE SET
					file_hash = excluded.file_hash,
					approved_by = excluded.approved_by,
					approved_at = excluded.approved_at
			`)
			.run(projectId, fileHash, approvedBy);
	},

	revoke(projectId: string): void {
		getDatabase().prepare('DELETE FROM project_mcp_trust WHERE project_id = ?').run(projectId);
	}
};
