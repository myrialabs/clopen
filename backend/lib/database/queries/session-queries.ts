import { getDatabase } from '../index';
import type { ChatSession, Branch } from '$shared/types/database/schema';

export const sessionQueries = {
	getAll(): ChatSession[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM chat_sessions 
			ORDER BY started_at DESC
		`).all() as ChatSession[];
	},

	getByProjectId(projectId: string): ChatSession[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM chat_sessions 
			WHERE project_id = ? 
			ORDER BY started_at DESC
		`).all(projectId) as ChatSession[];
	},

	getById(id: string): ChatSession | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM chat_sessions WHERE id = ?
		`).get(id) as ChatSession | null;
	},

	create(session: Omit<ChatSession, 'id'>): ChatSession {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const newSession = { id, ...session };

		db.prepare(`
			INSERT INTO chat_sessions (id, project_id, title, engine, latest_sdk_session_id, current_head_message_id, started_at, ended_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			session.project_id,
			session.title || null,
			session.engine || 'claude-code',
			session.latest_sdk_session_id || null,
			session.current_head_message_id || null,
			session.started_at,
			session.ended_at || null
		);

		return newSession;
	},

	updateTitle(id: string, title: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions 
			SET title = ? 
			WHERE id = ?
		`).run(title, id);
	},

	updateLatestSdkSessionId(id: string, sdkSessionId: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET latest_sdk_session_id = ?
			WHERE id = ?
		`).run(sdkSessionId, id);
	},

	updateEngineModel(id: string, engine: string, model: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET engine = ?, model = ?
			WHERE id = ?
		`).run(engine, model, id);
	},

	updateClaudeAccountId(id: string, claudeAccountId: number | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET claude_account_id = ?
			WHERE id = ?
		`).run(claudeAccountId, id);
	},

	end(id: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			UPDATE chat_sessions
			SET ended_at = ?
			WHERE id = ?
		`).run(now, id);
	},

	/**
	 * Reactivate a session (clear ended_at).
	 * Does NOT end other sessions — multiple sessions can be active in parallel.
	 */
	reactivate(id: string): void {
		const db = getDatabase();

		const session = this.getById(id);
		if (!session) {
			throw new Error('Session not found');
		}

		// Clear ended_at for the target session (reactivate it)
		db.prepare(`
			UPDATE chat_sessions
			SET ended_at = NULL
			WHERE id = ?
		`).run(id);
	},

	delete(id: string): void {
		const db = getDatabase();
		// Delete related messages first
		db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
		db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
	},

	/**
	 * Get the active shared session for a project
	 * Returns the most recent session that hasn't ended
	 */
	getActiveSessionForProject(projectId: string): ChatSession | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM chat_sessions 
			WHERE project_id = ? AND ended_at IS NULL
			ORDER BY started_at DESC
			LIMIT 1
		`).get(projectId) as ChatSession | null;
	},

	/**
	 * Get all active (non-ended) sessions for a project.
	 * Supports parallel multi-session workflow.
	 */
	getActiveSessionsForProject(projectId: string): ChatSession[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM chat_sessions
			WHERE project_id = ? AND ended_at IS NULL
			ORDER BY started_at DESC
		`).all(projectId) as ChatSession[];
	},

	/**
	 * Get or create a shared session for a project.
	 * When forceNew=true, creates a new session WITHOUT ending existing ones
	 * (multiple sessions can be active in parallel).
	 */
	getOrCreateSharedSession(projectId: string, projectName: string, forceNew: boolean = false): ChatSession {
		if (!forceNew) {
			// Return most recent active session if exists
			const activeSession = this.getActiveSessionForProject(projectId);
			if (activeSession) {
				return activeSession;
			}
		}

		// Create a new session (existing sessions stay active)
		const now = new Date().toISOString();
		return this.create({
			project_id: projectId,
			title: `Shared Chat - ${projectName} (${new Date().toLocaleString()})`,
			started_at: now,
			ended_at: undefined,
			latest_sdk_session_id: undefined
		});
	},

	// ==================== GIT-LIKE BRANCH OPERATIONS ====================

	/**
	 * Update the current HEAD pointer of a session
	 * This is like "git checkout" - moves HEAD to a different commit
	 */
	updateHead(sessionId: string, messageId: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET current_head_message_id = ?
			WHERE id = ?
		`).run(messageId, sessionId);
	},

	/**
	 * Get current HEAD message ID for a session
	 */
	getHead(sessionId: string): string | null {
		const db = getDatabase();
		const session = db.prepare(`
			SELECT current_head_message_id FROM chat_sessions WHERE id = ?
		`).get(sessionId) as { current_head_message_id: string | null } | null;

		return session?.current_head_message_id || null;
	},

	/**
	 * Save a branch (creates a named pointer to a message)
	 */
	saveBranch(sessionId: string, branchName: string, headMessageId: string): Branch {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		const branch: Branch = {
			id,
			session_id: sessionId,
			branch_name: branchName,
			head_message_id: headMessageId,
			created_at: now
		};

		db.prepare(`
			INSERT INTO branches (id, session_id, branch_name, head_message_id, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(id, sessionId, branchName, headMessageId, now);

		return branch;
	},

	/**
	 * Get branch HEAD by branch name
	 */
	getBranchHead(sessionId: string, branchName: string): string | null {
		const db = getDatabase();
		const branch = db.prepare(`
			SELECT head_message_id FROM branches
			WHERE session_id = ? AND branch_name = ?
		`).get(sessionId, branchName) as { head_message_id: string } | null;

		return branch?.head_message_id || null;
	},

	/**
	 * Get all branches for a session
	 */
	getAllBranches(sessionId: string): Branch[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM branches
			WHERE session_id = ?
			ORDER BY created_at DESC
		`).all(sessionId) as Branch[];
	},

	/**
	 * Delete a branch
	 */
	deleteBranch(branchId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM branches WHERE id = ?').run(branchId);
	},

	/**
	 * Update branch HEAD (when branch grows with new commits)
	 */
	updateBranchHead(sessionId: string, branchName: string, newHeadMessageId: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE branches
			SET head_message_id = ?
			WHERE session_id = ? AND branch_name = ?
		`).run(newHeadMessageId, sessionId, branchName);
	}
};