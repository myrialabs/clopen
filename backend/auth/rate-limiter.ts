/**
 * Auth Rate Limiter
 *
 * Protects auth endpoints against brute-force and credential stuffing attacks.
 * Tracks failed attempts per IP with progressive lockout.
 *
 * Thresholds:
 *   5 failures  → 30 second lockout
 *   10 failures → 2 minute lockout
 *   20 failures → 10 minute lockout
 *
 * Attempts decay after the lockout window expires.
 */

import { debug } from '$shared/utils/logger';

/** Routes that should be rate-limited */
const RATE_LIMITED_ROUTES = new Set([
	'auth:login',
	'auth:accept-invite',
	'auth:validate-invite',
	'auth:claim-device-code',
	'auth:setup'
]);

interface AttemptRecord {
	failures: number;
	lastFailure: number;
	lockedUntil: number;
}

/** Lockout tiers: [maxFailures, lockoutMs] */
const LOCKOUT_TIERS: [number, number][] = [
	[5, 30_000],       // 5 failures  → 30 seconds
	[10, 2 * 60_000],  // 10 failures → 2 minutes
	[20, 10 * 60_000], // 20 failures → 10 minutes
];

/** After this duration of no failures, the record is considered stale and cleaned up */
const STALE_AFTER_MS = 15 * 60_000; // 15 minutes

/** How often to run cleanup (ms) */
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

class AuthRateLimiter {
	private attempts = new Map<string, AttemptRecord>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Periodic cleanup of stale entries
		this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
	}

	/**
	 * Check if an action is rate-limited for the given identifier.
	 * Returns null if allowed, or an error message if blocked.
	 */
	check(identifier: string, action: string): string | null {
		if (!RATE_LIMITED_ROUTES.has(action)) {
			return null; // Not a rate-limited route
		}

		const record = this.attempts.get(identifier);
		if (!record) {
			return null; // No previous failures
		}

		const now = Date.now();

		// Check if currently locked out
		if (record.lockedUntil > now) {
			const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
			debug.warn('auth', `Rate limited: ${identifier} (${remainingSec}s remaining, ${record.failures} failures)`);
			return `Too many failed attempts. Try again in ${remainingSec} seconds.`;
		}

		return null;
	}

	/**
	 * Record a failed auth attempt for the given identifier.
	 */
	recordFailure(identifier: string, action: string): void {
		if (!RATE_LIMITED_ROUTES.has(action)) return;

		const now = Date.now();
		const record = this.attempts.get(identifier) ?? { failures: 0, lastFailure: 0, lockedUntil: 0 };

		record.failures += 1;
		record.lastFailure = now;

		// Determine lockout duration based on failure count
		let lockoutMs = 0;
		for (const [threshold, duration] of LOCKOUT_TIERS) {
			if (record.failures >= threshold) {
				lockoutMs = duration;
			}
		}

		if (lockoutMs > 0) {
			record.lockedUntil = now + lockoutMs;
			debug.warn('auth', `Lockout triggered: ${identifier} — ${record.failures} failures, locked for ${lockoutMs / 1000}s`);
		}

		this.attempts.set(identifier, record);
	}

	/**
	 * Clear failure record on successful auth (e.g., successful login).
	 */
	recordSuccess(identifier: string): void {
		this.attempts.delete(identifier);
	}

	/**
	 * Remove stale entries to prevent memory leaks.
	 */
	private cleanup(): void {
		const now = Date.now();
		let removed = 0;

		for (const [key, record] of this.attempts) {
			if (now - record.lastFailure > STALE_AFTER_MS && record.lockedUntil < now) {
				this.attempts.delete(key);
				removed++;
			}
		}

		if (removed > 0) {
			debug.log('auth', `Rate limiter cleanup: removed ${removed} stale entries`);
		}
	}

	/**
	 * Dispose — stop cleanup timer.
	 */
	dispose(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}
}

/** Singleton rate limiter instance */
export const authRateLimiter = new AuthRateLimiter();
