/**
 * Background Terminal Service
 * Manages terminal sessions that persist across browser refreshes
 */

import { terminalSessionManager } from '../session.service';
import { terminalPersistenceManager } from '../persistence.service';
import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';

// Import modular services
import { streamManager } from './stream-manager';
import { sessionRestoreService } from './session-restore';

import type { StreamingResponse } from '../terminal.service';

class BackgroundTerminalService {
	private isInitialized = false;

	/**
	 * Initialize the background service
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized || typeof window === 'undefined') return;

		this.isInitialized = true;

		// Load persisted terminal sessions FIRST before any other initialization
		await sessionRestoreService.restoreTerminalSessions();

		// Save terminal state periodically
		this.startPeriodicSave();

		// Save state before unload
		window.addEventListener('beforeunload', () => {
			this.saveCurrentState();
		});
	}

	/**
	 * Check if there are restored sessions
	 */
	hasRestoredSessions(): boolean {
		return sessionRestoreService.hasRestoredSessions();
	}

	/**
	 * Check if restoration is done
	 */
	isRestorationDone(): boolean {
		return sessionRestoreService.isRestorationDone();
	}


	/**
	 * Check if a session has an active stream (PTY process running)
	 */
	hasActiveStream(sessionId: string): boolean {
		return streamManager.hasActiveStream(sessionId);
	}

	/**
	 * Check if any session has active streams
	 */
	hasAnyActiveStreams(): boolean {
		return streamManager.hasAnyActiveStreams();
	}

	/**
	 * Start a new terminal stream
	 */
	startStream(sessionId: string, streamId: string, command: string, projectId?: string): void {
		streamManager.startStream(sessionId, streamId, command, projectId);
		this.saveCurrentState();
	}

	/**
	 * End a terminal stream
	 */
	endStream(sessionId: string, forceClear: boolean = false): void {
		streamManager.endStream(sessionId, forceClear);
		this.saveCurrentState();
	}

	/**
	 * Save current terminal state
	 */
	private saveCurrentState(): void {
		sessionRestoreService.saveCurrentState();
	}

	/**
	 * Start periodic save
	 */
	private startPeriodicSave(): void {
		// Save state every 30 seconds
		setInterval(() => {
			this.saveCurrentState();
		}, 30000);
	}

	/**
	 * Check if service is ready
	 */
	isReady(): boolean {
		return this.isInitialized;
	}

	/**
	 * Get active streams count
	 */
	getActiveStreamsCount(): number {
		return streamManager.getActiveStreamsCount();
	}

	/**
	 * Clean up service
	 */
	cleanup(): void {
		// Clean up stream manager
		streamManager.cleanup();

		// Save final state
		this.saveCurrentState();

		this.isInitialized = false;
	}
}

// Export singleton instance
export const backgroundTerminalService = new BackgroundTerminalService();