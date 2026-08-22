/**
 * File Audit Log Queries
 * 
 * Functions for logging and retrieving file operation audit records.
 */

import { getDatabase } from '../index';
import { nanoid } from 'nanoid';
import { debug } from '$shared/utils/logger';

export interface FileAuditLogEntry {
	id: string;
	user_id: string;
	project_id: string | null;
	action: string;
	file_path: string;
	file_size: number | null;
	source_path: string | null;
	target_path: string | null;
	ip_address: string | null;
	user_agent: string | null;
	success: number;
	error_message: string | null;
	created_at: string;
}

export type FileAuditAction = 
	| 'upload'
	| 'download'
	| 'delete'
	| 'move'
	| 'rename'
	| 'copy'
	| 'zip'
	| 'unzip'
	| 'read'
	| 'write';

export interface LogFileOperationParams {
	userId: string;
	projectId?: string | null;
	action: FileAuditAction;
	filePath: string;
	fileSize?: number | null;
	sourcePath?: string | null;
	targetPath?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	success?: boolean;
	errorMessage?: string | null;
}

export const fileAuditLogQueries = {
	/**
	 * Log a file operation to the audit log
	 */
	logOperation(params: LogFileOperationParams): boolean {
		try {
			const db = getDatabase();
			const id = nanoid();
			const now = new Date().toISOString();

			db.prepare(`
				INSERT INTO file_audit_log (
					id, user_id, project_id, action, file_path, file_size,
					source_path, target_path, ip_address, user_agent,
					success, error_message, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				id,
				params.userId,
				params.projectId ?? null,
				params.action,
				params.filePath,
				params.fileSize ?? null,
				params.sourcePath ?? null,
				params.targetPath ?? null,
				params.ipAddress ?? null,
				params.userAgent ?? null,
				params.success !== false ? 1 : 0,
				params.errorMessage ?? null,
				now
			);

			return true;
		} catch (error) {
			debug.error('file', 'Failed to log file operation:', error);
			return false;
		}
	},

	/**
	 * Get audit log entries for a specific user
	 */
	getByUser(userId: string, limit: number = 100): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			WHERE user_id = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(userId, limit) as FileAuditLogEntry[];
	},

	/**
	 * Get audit log entries for a specific project
	 */
	getByProject(projectId: string, limit: number = 100): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			WHERE project_id = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(projectId, limit) as FileAuditLogEntry[];
	},

	/**
	 * Get audit log entries for a specific file path
	 */
	getByFilePath(filePath: string, limit: number = 50): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			WHERE file_path = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(filePath, limit) as FileAuditLogEntry[];
	},

	/**
	 * Get audit log entries by action type
	 */
	getByAction(action: FileAuditAction, limit: number = 100): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			WHERE action = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(action, limit) as FileAuditLogEntry[];
	},

	/**
	 * Get recent audit log entries
	 */
	getRecent(limit: number = 100): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			ORDER BY created_at DESC
			LIMIT ?
		`).all(limit) as FileAuditLogEntry[];
	},

	/**
	 * Get failed operations
	 */
	getFailedOperations(limit: number = 100): FileAuditLogEntry[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM file_audit_log
			WHERE success = 0
			ORDER BY created_at DESC
			LIMIT ?
		`).all(limit) as FileAuditLogEntry[];
	},

	/**
	 * Delete old audit log entries (for cleanup)
	 */
	deleteOlderThan(days: number): number {
		const db = getDatabase();
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - days);
		const cutoff = cutoffDate.toISOString();

		const result = db.prepare(`
			DELETE FROM file_audit_log
			WHERE created_at < ?
		`).run(cutoff);

		return (result as { changes: number }).changes;
	}
};
