import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type { BrowserConsoleMessage } from '$frontend/utils/native-ui';

/**
 * Console operations for one backend tab.
 *
 * Every call names its tab. They used to be sent bare and resolved against the
 * project's active tab — a single value shared by everyone in the project — so
 * with two people watching, reading or clearing the console could answer for
 * whichever tab the other one had most recently opened. The tab id was already
 * being passed in and thrown away.
 */
export class BrowserConsoleService {
	async getConsoleLogs(sessionId: string): Promise<BrowserConsoleMessage[]> {
		try {
			const result = await ws.http('preview:browser-console-get', { tabId: sessionId }, 5000);
			return result.logs || [];
		} catch (error) {
			debug.error('preview', 'Error getting console logs:', error);
			throw error;
		}
	}

	async clearConsoleLogs(sessionId: string): Promise<void> {
		try {
			await ws.http('preview:browser-console-clear', { tabId: sessionId }, 5000);
		} catch (error) {
			debug.error('preview', 'Error clearing console logs:', error);
			throw error;
		}
	}

	async executeConsoleCommand(sessionId: string, command: string): Promise<any> {
		try {
			const result = await ws.http('preview:browser-console-execute', { command, tabId: sessionId }, 10000);
			return result.result;
		} catch (error) {
			debug.error('preview', 'Error executing console command:', error);
			throw error;
		}
	}

	async toggleConsoleLogging(sessionId: string, enabled: boolean): Promise<void> {
		try {
			await ws.http('preview:browser-console-toggle', { enabled, tabId: sessionId }, 5000);
		} catch (error) {
			debug.error('preview', 'Error toggling console logging:', error);
			throw error;
		}
	}
}

// Singleton instance
export const browserConsoleService = new BrowserConsoleService();
