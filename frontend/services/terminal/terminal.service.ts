/**
 * Terminal Service — PtyKit control surface.
 *
 * Rendering + I/O are owned by the `<PtyTerminal>` component (from
 * @myrialabs/ptykit/svelte), which drives the shared `ptyClient`. This service
 * is the non-render control surface — close/clear/cancel/resize from the tab bar
 * and project cleanup — acting on the live session handles registered by each
 * mounted terminal. It keeps its previous method names so existing callers
 * (store, project.service) are unchanged.
 */

import { ptyClient, getSession, unregisterSession } from './ptykit-client';
import { debug } from '$shared/utils/logger';

export interface TerminalConnectOptions {
	sessionId: string;
	workingDirectory?: string;
	projectPath?: string;
	projectId?: string;
	terminalSize?: { cols: number; rows: number };
}

/** Retained for the terminal store's typing; output now streams via <PtyTerminal>. */
export interface StreamingResponse {
	type: 'output' | 'error' | 'directory' | 'exit' | 'complete' | 'clear-screen';
	content?: string;
	newDirectory?: string;
	sessionId?: string;
	projectId?: string;
	timestamp?: string;
}

export class TerminalService {
	/** Send Ctrl+C to the session (interactive interrupt). */
	async cancelCommand(sessionId: string): Promise<boolean> {
		const session = getSession(sessionId);
		if (!session) return false;
		try {
			await session.cancel();
			return true;
		} catch (error) {
			debug.error('terminal', 'Error sending Ctrl+C:', error);
			return false;
		}
	}

	/** Clear the server-side headless scrollback (sync with a frontend clear). */
	async clearHeadlessTerminal(sessionId: string): Promise<void> {
		try {
			await getSession(sessionId)?.clear();
		} catch {
			/* non-critical */
		}
	}

	/** Resize the PTY + headless terminal (the component also fits on its own). */
	async resizeTerminal(sessionId: string, cols: number, rows: number): Promise<boolean> {
		const session = getSession(sessionId);
		if (!session) return false;
		try {
			await session.resize(cols, rows);
			return true;
		} catch (error) {
			debug.error('terminal', 'Error resizing terminal:', error);
			return false;
		}
	}

	/** Send raw keystrokes to the PTY. */
	sendInput(sessionId: string, data: string): void {
		getSession(sessionId)?.write(data);
	}

	/** Kill the server-side session and drop the local handle. */
	async killSession(sessionId: string): Promise<boolean> {
		const session = getSession(sessionId);
		unregisterSession(sessionId);
		if (!session) return false;
		try {
			await session.kill();
			return true;
		} catch (error) {
			debug.error('terminal', 'Error killing session:', error);
			return false;
		}
	}

	/**
	 * Shell availability. PtyKit auto-detects the backend/shell server-side; the
	 * frontend only needs a display label, derived from the browser platform.
	 */
	async checkShellAvailability(): Promise<{
		available: boolean;
		path: string | null;
		platform: string;
		isWindows: boolean;
		shellType: string;
	}> {
		const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);
		return {
			available: true,
			path: null,
			platform: isWindows ? 'win32' : 'posix',
			isWindows,
			shellType: isWindows ? 'PowerShell' : 'Bash'
		};
	}

	/**
	 * Missed output. PtyKit replays a serialized scrollback frame automatically on
	 * (re)attach, so there is nothing to fetch separately.
	 */
	async getMissedOutput(): Promise<{ success: boolean; output: string; status: string }> {
		return { success: true, output: '', status: 'active' };
	}

	/** List active PTY sessions for a project (namespace), for refresh discovery. */
	async listProjectSessions(projectId: string): Promise<Array<{
		sessionId: string;
		pid: number;
		cwd: string;
		createdAt: string;
		lastActivityAt: string;
	}>> {
		try {
			const data = await ptyClient.listSessions(projectId);
			return data.sessions ?? [];
		} catch {
			return [];
		}
	}

	/** Drop the local handle for a session (does NOT kill the server session). */
	cleanupListeners(sessionId: string): void {
		unregisterSession(sessionId);
	}

	hasActiveListeners(sessionId: string): boolean {
		return getSession(sessionId) !== undefined;
	}

	/** No-op retained for API compatibility (component owns lifecycle). */
	cleanup(): void {}
}

export const terminalService = new TerminalService();
