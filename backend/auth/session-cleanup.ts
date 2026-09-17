/**
 * Expired Session Cleanup Scheduler
 *
 * Periodically removes expired auth sessions from the database, along with
 * the other one-time bearer credentials that age out the same way
 * (device-pairing codes, file-share links).
 * Without this, the auth_sessions table grows unbounded as expired
 * sessions are never purged in long-running deployments.
 *
 * Pattern: same timer + dispose() approach as AuthRateLimiter.
 */

import { authQueries } from '../database/queries';
import { sweepStaleFileShares } from '../files/file-shares';
import { debug } from '$shared/utils/logger';

/** How often to sweep for expired sessions (1 hour) */
const CLEANUP_INTERVAL_MS = 60 * 60_000;

class SessionCleanupScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Timer is started in start(), not here — database may not be initialized yet.
	}

	/**
	 * Start the periodic cleanup timer and run an initial sweep.
	 * Must be called AFTER database initialization.
	 */
	start(): void {
		if (this.timer) return; // Already started
		this.timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
		// Run once at startup so long-stale sessions are cleared immediately
		this.cleanup();
	}

	private cleanup(): void {
		try {
			const deleted = authQueries.deleteExpiredSessions();
			if (deleted > 0) {
				debug.log('auth', `Session cleanup: removed ${deleted} expired session(s)`);
			}
			// Sweep expired / already-claimed device-pairing codes alongside sessions.
			const staleCodes = authQueries.deleteStaleDeviceCodes();
			if (staleCodes > 0) {
				debug.log('auth', `Session cleanup: removed ${staleCodes} stale device code(s)`);
			}
			// Same shape again: one-time file-share links that can no longer
			// serve bytes (expired, or drained out after their single use).
			const staleShares = sweepStaleFileShares();
			if (staleShares > 0) {
				debug.log('auth', `Session cleanup: removed ${staleShares} stale file share(s)`);
			}
		} catch (error) {
			debug.warn('auth', 'Session cleanup failed:', error);
		}
	}

	/**
	 * Dispose — stop cleanup timer. Called during graceful shutdown.
	 */
	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

/** Singleton instance — started when the module is imported */
export const sessionCleanupScheduler = new SessionCleanupScheduler();
