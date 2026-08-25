/**
 * Auth Rate Limiter
 *
 * Protects auth endpoints against brute-force and credential stuffing attacks.
 * Tracks failed attempts per (IP, route) with progressive lockout, plus a
 * volume cap on *all* attempts (success + failure) per (IP, route) so that
 * probes alternating valid and invalid tokens cannot avoid the limit.
 *
 * Failure tiers:
 *   5 failures  → 30 second lockout
 *   10 failures → 2 minute lockout
 *   20 failures → 10 minute lockout
 *
 * Volume cap:
 *   100 attempts per (IP, route) within a 15-minute sliding window →
 *   15-minute lockout, regardless of success/failure mix. Defends routes
 *   like `auth:validate-invite` against high-volume probing of token
 *   space, including probes that happen to find a valid token.
 *
 * Attempts decay after the lockout window expires.
 */

import { debug } from '$shared/utils/logger';

/** Routes that should be rate-limited. */
const RATE_LIMITED_ROUTES = new Set([
	'auth:login',
	'auth:accept-invite',
	'auth:validate-invite',
	'auth:claim-device-code',
	'auth:setup'
]);

interface AttemptRecord {
	failures: number;
	attempts: number;
	attemptWindowStart: number;
	lastFailure: number;
	lockedUntil: number;
}

/** Lockout tiers: [maxFailures, lockoutMs] */
const LOCKOUT_TIERS: [number, number][] = [
	[5, 30_000],       // 5 failures  → 30 seconds
	[10, 2 * 60_000],  // 10 failures → 2 minutes
	[20, 10 * 60_000], // 20 failures → 10 minutes
];

/** Volume cap: max attempts (success or failure) per route per sliding window. */
const ATTEMPT_CAP = 100;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const ATTEMPT_LOCKOUT_MS = 15 * 60_000;

/** After this duration of no activity, the record is considered stale and cleaned up. */
const STALE_AFTER_MS = 15 * 60_000; // 15 minutes

/** How often to run cleanup (ms) */
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class AuthRateLimiter {
	// Key format: `${identifier}::${action}` — per (IP, route) isolation.
	private attempts = new Map<string, AttemptRecord>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Periodic cleanup of stale entries
		this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
	}

	private static key(identifier: string, action: string): string {
		return `${identifier}::${action}`;
	}

	/**
	 * Check if an action is rate-limited for the given identifier.
	 * Returns null if allowed, or an error message if blocked.
	 */
	check(identifier: string, action: string): string | null {
		if (!RATE_LIMITED_ROUTES.has(action)) {
			return null; // Not a rate-limited route
		}

		const record = this.attempts.get(AuthRateLimiter.key(identifier, action));
		if (!record) {
			return null; // No previous activity
		}

		const now = Date.now();

		// Check if currently locked out (either failure-tier or volume-tier)
		if (record.lockedUntil > now) {
			const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
			debug.warn('auth', `Rate limited: ${identifier} on ${action} (${remainingSec}s remaining, ${record.failures} failures, ${record.attempts} attempts)`);
			return `Too many failed attempts. Try again in ${remainingSec} seconds.`;
		}

		return null;
	}

	/**
	 * Record a failed auth attempt for the given identifier + action.
	 * Escalates the failure-tier lockout when a new threshold is crossed.
	 */
	recordFailure(identifier: string, action: string): void {
		if (!RATE_LIMITED_ROUTES.has(action)) return;

		const now = Date.now();
		const key = AuthRateLimiter.key(identifier, action);
		const record = this.attempts.get(key) ?? this.newRecord(now);

		record.failures += 1;
		record.lastFailure = now;
		record.attempts += 1;
		record.attemptWindowStart = this.maybeResetWindow(record, now);

		// Determine failure-tier lockout duration based on failure count
		let lockoutMs = 0;
		for (const [threshold, duration] of LOCKOUT_TIERS) {
			if (record.failures >= threshold) {
				lockoutMs = duration;
			}
		}

		if (lockoutMs > 0) {
			record.lockedUntil = now + lockoutMs;
			debug.warn('auth', `Lockout triggered: ${identifier} on ${action} — ${record.failures} failures, locked for ${lockoutMs / 1000}s`);
		}

		this.maybeApplyAttemptCap(record, now);
		this.attempts.set(key, record);
	}

	/**
	 * Record a successful auth attempt for the given identifier + action.
	 * Clears the per-route record so legitimate users don't accumulate debt
	 * across successful validations.
	 */
	recordSuccess(identifier: string, action: string): void {
		if (!RATE_LIMITED_ROUTES.has(action)) return;
		this.attempts.delete(AuthRateLimiter.key(identifier, action));
	}

	/**
	 * Record an auth attempt without recording a failure. Used for routes
	 * like `auth:validate-invite` where a successful call should still
	 * count toward the volume cap (so high-volume probes can't avoid it by
	 * happening to find valid tokens).
	 */
	recordAttempt(identifier: string, action: string): void {
		if (!RATE_LIMITED_ROUTES.has(action)) return;

		const now = Date.now();
		const key = AuthRateLimiter.key(identifier, action);
		const record = this.attempts.get(key) ?? this.newRecord(now);

		record.attempts += 1;
		record.attemptWindowStart = this.maybeResetWindow(record, now);
		this.maybeApplyAttemptCap(record, now);
		this.attempts.set(key, record);
	}

	private newRecord(now: number): AttemptRecord {
		return {
			failures: 0,
			attempts: 0,
			attemptWindowStart: now,
			lastFailure: 0,
			lockedUntil: 0
		};
	}

	/**
	 * If the sliding attempt window has expired, reset the counter. Returns
	 * the (possibly updated) window start.
	 */
	private maybeResetWindow(record: AttemptRecord, now: number): number {
		if (now - record.attemptWindowStart >= ATTEMPT_WINDOW_MS) {
			record.attempts = 0;
			record.attemptWindowStart = now;
		}
		return record.attemptWindowStart;
	}

	/**
	 * If the attempt count has reached the cap, apply the volume-tier lockout.
	 */
	private maybeApplyAttemptCap(record: AttemptRecord, now: number): void {
		if (record.attempts >= ATTEMPT_CAP && record.lockedUntil < now + ATTEMPT_LOCKOUT_MS) {
			record.lockedUntil = now + ATTEMPT_LOCKOUT_MS;
			debug.warn('auth', `Volume lockout triggered: ${record.attempts} attempts in window, locked for ${ATTEMPT_LOCKOUT_MS / 1000}s`);
		}
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
