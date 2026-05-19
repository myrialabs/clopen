/**
 * WebSocket Message Rate Limiter
 *
 * Protects against DoS via message spam from authenticated connections.
 * Tracks message frequency per connection with a sliding window.
 *
 * Thresholds:
 *   50 messages/second  → warning logged
 *   100 messages/second → connection throttled (messages dropped)
 *   200 messages/second → connection flagged for potential disconnect
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

	checkRateLimit(conn: WSConnection, action: string): boolean {
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
