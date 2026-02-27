import { getDatabase } from '../index';
import type { DatabaseMessage } from '$shared/types/database/schema';

import { debug } from '$shared/utils/logger';
export const dbUtils = {
	// Get dashboard statistics
	getStats(): {
		totalProjects: number;
		totalSessions: number;
		totalMessages: number;
	} {
		const db = getDatabase();

		const totalProjects = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }).count;
		const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM chat_sessions').get() as { count: number }).count;
		const totalMessages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;

		return {
			totalProjects,
			totalSessions,
			totalMessages
		};
	},

	// Search across messages
	searchMessages(query: string, limit: number = 50): (DatabaseMessage & { project_name: string })[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT m.*, p.name as project_name
			FROM messages m
			JOIN chat_sessions cs ON m.session_id = cs.id
			JOIN projects p ON cs.project_id = p.id
			WHERE m.content LIKE ?
			ORDER BY m.timestamp DESC
			LIMIT ?
		`).all(`%${query}%`, limit) as (DatabaseMessage & { project_name: string })[];
	},

	// Clean up old data
	cleanupOldData(daysOld: number = 30): void {
		const db = getDatabase();
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - daysOld);
		const cutoff = cutoffDate.toISOString();
		
		// Delete old ended sessions and their messages
		const oldSessions = db.prepare(`
			SELECT id FROM chat_sessions 
			WHERE ended_at IS NOT NULL AND ended_at < ?
		`).all(cutoff) as { id: string }[];
		
		for (const session of oldSessions) {
			db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
			db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(session.id);
		}
		
		debug.log('database', `✅ Cleaned up ${oldSessions.length} old sessions`);
	}
};