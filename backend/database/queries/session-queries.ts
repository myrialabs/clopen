import { getDatabase } from '../index';
import type { ChatSession, Branch, DatabaseMessage } from '$shared/types/database/schema';
import { loadMessage } from '$shared/utils/message-formatter';
import { extractMessageText } from '../../snapshot/helpers';

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
			INSERT INTO chat_sessions (id, project_id, title, engine, head_session_id, head_message_id, started_at, ended_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			session.project_id,
			session.title || null,
			session.engine || 'claude-code',
			session.head_session_id || null,
			session.head_message_id || null,
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

	updateSessionId(id: string, sessionId: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET head_session_id = ?
			WHERE id = ?
		`).run(sessionId, id);
	},

	clearSessionId(id: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET head_session_id = NULL
			WHERE id = ?
		`).run(id);
	},

	updateEngineModel(id: string, engine: string, provider: string, modelId: string, modelName: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET engine = ?, provider = ?, model_id = ?, model_name = ?
			WHERE id = ?
		`).run(engine, provider, modelId, modelName, id);
	},

	/** Persist the active profile for a session (NULL clears it). */
	updateProfile(id: string, profileId: number | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET profile_id = ?
			WHERE id = ?
		`).run(profileId, id);
	},

	updateAccountId(id: string, accountId: number | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET account_id = ?
			WHERE id = ?
		`).run(accountId, id);
	},

	updateAccount(id: string, accountId: number | null, accountName: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET account_id = ?, account_name = ?
			WHERE id = ?
		`).run(accountId, accountName, id);
	},

	/**
	 * Update session metadata after a message is saved.
	 * Increments counts, updates sender, timestamps, and HEAD content snapshot.
	 */
	updateOnMessage(id: string, opts: {
		messageType: string;
		senderId?: string | null;
		senderName?: string | null;
		timestamp: string;
		headTitle?: string | null;
		headSummary?: string | null;
		isFirstUserMessage?: boolean;
		title?: string;
	}): void {
		const db = getDatabase();
		const sets: string[] = [
			'message_count = COALESCE(message_count, 0) + 1',
			'last_message_at = ?',
		];
		const params: (string | number | null)[] = [opts.timestamp];

		if (opts.messageType === 'user') {
			sets.push('user_count = COALESCE(user_count, 0) + 1');
		}

		if (opts.senderId !== undefined) {
			sets.push('sender_id = ?');
			params.push(opts.senderId ?? null);
		}
		if (opts.senderName !== undefined) {
			sets.push('sender_name = ?');
			params.push(opts.senderName ?? null);
		}

		if (opts.headTitle !== undefined) {
			sets.push('head_title = ?');
			params.push(opts.headTitle ?? null);
		}
		if (opts.headSummary !== undefined) {
			sets.push('head_summary = ?');
			params.push(opts.headSummary ?? null);
		}

		// Auto-set title from first user message
		if (opts.isFirstUserMessage && opts.title) {
			sets.push('title = ?');
			params.push(opts.title);
		}

		params.push(id);
		db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
	},

	/**
	 * Re-derive HEAD content snapshot from the HEAD chain.
	 * Called after undo/redo/restore when HEAD changes.
	 */
	updateHeadSnapshot(id: string, headTitle: string | null, headSummary: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET head_title = ?, head_summary = ?
			WHERE id = ?
		`).run(headTitle, headSummary, id);
	},

	/**
	 * Re-derive HEAD snapshot by walking the HEAD chain.
	 * Called after undo/redo/restore when HEAD changes.
	 */
	rederiveHeadSnapshot(sessionId: string): void {
		const db = getDatabase();
		const session = db.prepare('SELECT head_message_id FROM chat_sessions WHERE id = ?')
			.get(sessionId) as { head_message_id: string | null } | null;

		if (!session?.head_message_id) {
			// HEAD cleared (initial state) — clear snapshot
			this.updateHeadSnapshot(sessionId, null, null);
			return;
		}

		// Build lookup for HEAD chain walk
		const allMsgs = db.prepare(
			'SELECT id, data, parent_message_id FROM messages WHERE session_id = ?'
		).all(sessionId) as DatabaseMessage[];
		const msgLookup = new Map(allMsgs.map(m => [m.id, m]));

		let headTitle: string | null = null;
		let headSummary: string | null = null;
		let walkId: string | null = session.head_message_id;

		while (walkId) {
			const row = msgLookup.get(walkId);
			if (!row) break;

			const msg = loadMessage(row);

			if (!headSummary && msg.type === 'assistant') {
				const text = extractMessageText(msg);
				const clean = text.replace(/```[\s\S]*?```/g, '').trim();
				if (clean) {
					headSummary = clean.slice(0, 200) + (clean.length > 200 ? '...' : '');
				}
			}
			if (!headTitle && msg.type === 'user') {
				const text = extractMessageText(msg).trim();
				if (text) {
					headTitle = text.slice(0, 80) + (text.length > 80 ? '...' : '');
				}
			}

			if (headTitle && headSummary) break;
			walkId = row.parent_message_id || null;
		}

		this.updateHeadSnapshot(sessionId, headTitle, headSummary);
	},

	/**
	 * Search sessions by message content.
	 * Returns session IDs that have matching messages.
	 */
	searchByMessageContent(projectId: string, query: string, limit: number = 20): string[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT DISTINCT m.session_id
			FROM messages m
			INNER JOIN chat_sessions cs ON cs.id = m.session_id
			WHERE cs.project_id = ?
			  AND m.data LIKE ?
			LIMIT ?
		`).all(projectId, `%${query}%`, limit) as { session_id: string }[];
		return rows.map(r => r.session_id);
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
		// Delete all related data
		db.prepare('DELETE FROM branches WHERE session_id = ?').run(id);
		db.prepare('DELETE FROM message_snapshots WHERE session_id = ?').run(id);
		db.prepare('DELETE FROM session_relationships WHERE parent_session_id = ? OR child_session_id = ?').run(id, id);
		db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
		db.prepare('DELETE FROM user_unread_sessions WHERE session_id = ?').run(id);
		// Clear current_session_id references in user_projects
		db.prepare('UPDATE user_projects SET current_session_id = NULL WHERE current_session_id = ?').run(id);
		db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
	},

	/**
	 * Delete all sessions for a project and their related data.
	 * Returns the list of deleted session IDs.
	 */
	deleteAllByProjectId(projectId: string): string[] {
		const db = getDatabase();
		const sessions = db.prepare('SELECT id FROM chat_sessions WHERE project_id = ?')
			.all(projectId) as { id: string }[];
		const sessionIds = sessions.map(s => s.id);

		if (sessionIds.length === 0) return [];

		// Delete all related data for the project's sessions
		db.prepare('DELETE FROM branches WHERE session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)').run(projectId);
		db.prepare('DELETE FROM message_snapshots WHERE project_id = ?').run(projectId);
		db.prepare(`
			DELETE FROM session_relationships
			WHERE parent_session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)
			   OR child_session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)
		`).run(projectId, projectId);
		db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)').run(projectId);
		db.prepare('DELETE FROM user_unread_sessions WHERE project_id = ?').run(projectId);
		// Clear current_session_id references in user_projects for this project
		db.prepare('UPDATE user_projects SET current_session_id = NULL WHERE project_id = ?').run(projectId);
		db.prepare('DELETE FROM chat_sessions WHERE project_id = ?').run(projectId);

		return sessionIds;
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
			head_session_id: undefined
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
			SET head_message_id = ?
			WHERE id = ?
		`).run(messageId, sessionId);
	},

	/**
	 * Clear the HEAD pointer (set to NULL).
	 * Used when restoring to the initial state (before any messages).
	 */
	clearHead(sessionId: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE chat_sessions
			SET head_message_id = NULL
			WHERE id = ?
		`).run(sessionId);
	},

	/**
	 * Get current HEAD message ID for a session
	 */
	getHead(sessionId: string): string | null {
		const db = getDatabase();
		const session = db.prepare(`
			SELECT head_message_id FROM chat_sessions WHERE id = ?
		`).get(sessionId) as { head_message_id: string | null } | null;

		return session?.head_message_id || null;
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
	},

	// ==================== PER-USER UNREAD SESSION TRACKING ====================

	/**
	 * Mark a session as unread for a specific user
	 */
	markUnread(userId: string, sessionId: string, projectId: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT OR IGNORE INTO user_unread_sessions (user_id, session_id, project_id, marked_at)
			VALUES (?, ?, ?, ?)
		`).run(userId, sessionId, projectId, now);
	},

	/**
	 * Mark a session as read for a specific user
	 */
	markRead(userId: string, sessionId: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM user_unread_sessions
			WHERE user_id = ? AND session_id = ?
		`).run(userId, sessionId);
	},

	/**
	 * Mark every unread session in a project as read for a specific user
	 */
	markAllRead(userId: string, projectId: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM user_unread_sessions
			WHERE user_id = ? AND project_id = ?
		`).run(userId, projectId);
	},

	/**
	 * Get all unread session IDs for a user within a project
	 * Returns array of { sessionId, projectId }
	 */
	getUnreadSessions(userId: string, projectId: string): { session_id: string; project_id: string }[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT session_id, project_id FROM user_unread_sessions
			WHERE user_id = ? AND project_id = ?
		`).all(userId, projectId) as { session_id: string; project_id: string }[];
	}
};