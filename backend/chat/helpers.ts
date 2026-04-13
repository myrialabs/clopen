import type { StreamRequest } from '$shared/types/unified/stream';

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
export const sessionStore = new Map<string, StreamRequest>();

/**
 * Track active connections to prevent duplicates
 */
export const activeConnections = new Map<string, string>(); // streamId -> connectionId
