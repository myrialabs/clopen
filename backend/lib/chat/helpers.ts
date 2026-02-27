import { messageQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';
import type { SDKMessage, ClaudeStreamRequest } from '$shared/types/messaging';

/**
 * Bun-compatible existsSync implementation
 */
export async function existsSync(filePath: string): Promise<boolean> {
	try {
		const file = Bun.file(filePath);
		await file.stat();
		return true;
	} catch {
		return false;
	}
}

/**
 * In-memory storage for stream sessions (in production, use Redis or database)
 */
export const sessionStore = new Map<string, ClaudeStreamRequest>();

/**
 * Track active connections to prevent duplicates
 */
export const activeConnections = new Map<string, string>(); // streamId -> connectionId

/**
 * Save message to database using database function with current timestamp
 */
export async function saveMessageToDatabase(message: SDKMessage, sessionId: string, timestamp?: string): Promise<void> {
	try {
		messageQueries.create({
			session_id: sessionId,
			sdk_message: message,
			timestamp: timestamp || new Date().toISOString()
		});
	} catch (error) {
		debug.error('chat', 'Failed to save message to database:', error);
		// Don't throw - we don't want message saving to break the stream
	}
}
