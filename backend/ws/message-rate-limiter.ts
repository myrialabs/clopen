/**
 * WebSocket Message Rate Limiter
 *
 * Protects against DoS via message spam from authenticated connections.
 * Tracks message frequency per connection with a sliding window.
 *
 * Thresholds:
 *   50 messages/second  → warning logged
 *   100 messages/second → connection throttled (fire-and-forget events dropped)
 *   200 messages/second → connection closed
 *
 * WHAT GETS SHED WHEN THROTTLING
 *
 * Throttling drops events, never request-response calls, and the asymmetry is
 * the entire point. A busy Clopen tab is dominated by high-volume fire-and-
 * forget traffic — preview pointer moves at ~30/s per viewer, terminal
 * keystrokes, stream feedback — while the calls a panel actually waits on
 * (`files:list-tree`, `git:status`, `engine:*-accounts-list`) are a trickle by
 * comparison.
 *
 * Counting them in one bucket and dropping whatever arrived last meant the
 * flood survived and the request died. That is backwards twice over: a dropped
 * pointer move is invisible because the next one supersedes it a frame later,
 * whereas a dropped request leaves a panel with no data and a user with no
 * explanation. Worse, it was self-amplifying — a dropped request used to hang
 * its caller until the client tore the socket down and every panel refetched at
 * once, which is a bigger burst than the one that tripped the limiter.
 *
 * Abuse is still bounded, and by the threshold that was always the real one:
 * a connection genuinely spamming the server crosses 200/s and gets closed
 * regardless of what it is sending.
 */

import { debug } from '$shared/utils/logger';
import type { WSConnection } from '$shared/utils/ws-server';

interface RateLimitConfig {
	warningThreshold: number;
	throttleThreshold: number;
	disconnectThreshold: number;
	windowMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
	warningThreshold: 50,
	throttleThreshold: 100,
	disconnectThreshold: 200,
	windowMs: 1000
};

interface ConnectionRateState {
	messageTimestamps: number[];
	isWarning: boolean;
	isThrottled: boolean;
	isFlagged: boolean;
	messagesDropped: number;
}

export class MessageRateLimiter {
	private config: RateLimitConfig;
	private connectionStates = new WeakMap<object, ConnectionRateState>();

	constructor(config?: Partial<RateLimitConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	private getState(conn: WSConnection): ConnectionRateState {
		const raw = (conn as any).raw ?? conn;
		let state = this.connectionStates.get(raw);
		if (!state) {
			state = {
				messageTimestamps: [],
				isWarning: false,
				isThrottled: false,
				isFlagged: false,
				messagesDropped: 0
			};
			this.connectionStates.set(raw, state);
		}
		return state;
	}

	/**
	 * @param isRequest Whether `action` is a request-response route — i.e. a
	 *   caller is blocked waiting for its reply. Such calls are counted like
	 *   everything else but are never shed by throttling; see the note at the
	 *   top of this file.
	 */
	checkRateLimit(conn: WSConnection, action: string, isRequest = false): boolean {
		const state = this.getState(conn);
		const now = Date.now();
		const windowStart = now - this.config.windowMs;
		state.messageTimestamps = state.messageTimestamps.filter(ts => ts > windowStart);
		state.messageTimestamps.push(now);

		const messageCount = state.messageTimestamps.length;
		const messagesPerSecond = messageCount / (this.config.windowMs / 1000);

		if (messagesPerSecond >= this.config.disconnectThreshold) {
			if (!state.isFlagged) {
				state.isFlagged = true;
				state.isThrottled = true;
				state.isWarning = false;
				debug.warn('rate-limit', `Connection flagged for disconnect: ${messagesPerSecond.toFixed(0)} msg/s on action ${action}`);
				try {
					conn.close(1008, 'Rate limit exceeded');
				} catch (error) {
					debug.warn('rate-limit', 'Failed to close rate-limited connection:', error);
				}
			}
			state.messagesDropped++;
			return false;
		}

		if (messagesPerSecond >= this.config.throttleThreshold) {
			if (!state.isThrottled) {
				state.isThrottled = true;
				state.isWarning = false;
				debug.warn('rate-limit', `Connection throttled: ${messagesPerSecond.toFixed(0)} msg/s on action ${action}`);
			}
			// Shed the flood, not the thing somebody is waiting on. Below the
			// disconnect threshold a request is always answered; above it the
			// connection is gone anyway.
			if (isRequest) return true;
			state.messagesDropped++;
			return false;
		}

		if (messagesPerSecond >= this.config.warningThreshold) {
			if (!state.isWarning) {
				state.isWarning = true;
				state.isThrottled = false;
				state.isFlagged = false;
				debug.warn('rate-limit', `High message rate: ${messagesPerSecond.toFixed(0)} msg/s on action ${action}`);
			}
			return true;
		}

		state.isWarning = false;
		state.isThrottled = false;
		state.isFlagged = false;
		return true;
	}

	isFlaggedForDisconnect(conn: WSConnection): boolean {
		return this.getState(conn).isFlagged;
	}

	getConnectionStats(conn: WSConnection): { messagesPerSecond: number; isThrottled: boolean; isFlagged: boolean; messagesDropped: number } | null {
		const state = this.getState(conn);
		const now = Date.now();
		const windowStart = now - this.config.windowMs;
		const recentMessages = state.messageTimestamps.filter(ts => ts > windowStart);
		const messagesPerSecond = recentMessages.length / (this.config.windowMs / 1000);
		return { messagesPerSecond, isThrottled: state.isThrottled, isFlagged: state.isFlagged, messagesDropped: state.messagesDropped };
	}

	reset(conn: WSConnection): void {
		const raw = (conn as any).raw ?? conn;
		this.connectionStates.delete(raw);
	}

}

export const messageRateLimiter = new MessageRateLimiter();
