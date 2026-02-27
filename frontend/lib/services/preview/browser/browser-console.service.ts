import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

export interface ConsoleMessage {
	id: string;
	type: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'clear';
	text: string;
	args?: unknown[];
	location?: {
		url: string;
		lineNumber: number;
		columnNumber: number;
	};
	stackTrace?: string;
	timestamp: number;
}

export class BrowserConsoleService {
	async getConsoleLogs(sessionId: string): Promise<ConsoleMessage[]> {
		try {
			const result = await ws.http('preview:browser-console-get', {}, 5000);
			return result.logs || [];
		} catch (error) {
			debug.error('preview', 'Error getting console logs:', error);
			throw error;
		}
	}

	async clearConsoleLogs(sessionId: string): Promise<void> {
		try {
			await ws.http('preview:browser-console-clear', {}, 5000);
		} catch (error) {
			debug.error('preview', 'Error clearing console logs:', error);
			throw error;
		}
	}

	async executeConsoleCommand(sessionId: string, command: string): Promise<any> {
		try {
			// Backend uses active tab automatically
			const result = await ws.http('preview:browser-console-execute', { command }, 10000);
			return result.result;
		} catch (error) {
			debug.error('preview', 'Error executing console command:', error);
			throw error;
		}
	}

	async toggleConsoleLogging(sessionId: string, enabled: boolean): Promise<void> {
		try {
			// Backend uses active tab automatically
			await ws.http('preview:browser-console-toggle', { enabled }, 5000);
		} catch (error) {
			debug.error('preview', 'Error toggling console logging:', error);
			throw error;
		}
	}
}

// Singleton instance
export const browserConsoleService = new BrowserConsoleService();
