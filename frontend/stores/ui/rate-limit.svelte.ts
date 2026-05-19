/**
 * Rate Limit Banner State
 *
 * Tracks the latest engine rate-limit snapshot keyed by `${engine}:${accountId}`
 * so the docked banner applies to every chat session sharing the same account.
 * The backend re-emits the snapshot on `chat:join-session`, so this store
 * survives page refresh and session switches without local persistence.
 */

export type RateLimitStatus = 'allowed_warning' | 'rejected';

export type RateLimitType =
	| 'five_hour'
	| 'seven_day'
	| 'seven_day_opus'
	| 'seven_day_sonnet'
	| 'overage';

export interface RateLimitState {
	engine: string;
	accountId: number;
	status: RateLimitStatus;
	utilization: number;
	resetsAt: number | null;
	rateLimitType: RateLimitType | null;
}

export function getAccountKey(engine: string, accountId: number): string {
	return `${engine}:${accountId}`;
}

export const rateLimitStore = $state<{
	byAccount: Record<string, RateLimitState>;
}>({ byAccount: {} });

const autoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelAutoClear(key: string): void {
	const timer = autoClearTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		autoClearTimers.delete(key);
	}
}

export function setRateLimit(state: RateLimitState): void {
	const key = getAccountKey(state.engine, state.accountId);
	cancelAutoClear(key);
	rateLimitStore.byAccount[key] = state;

	if (state.resetsAt) {
		const ms = state.resetsAt * 1000 - Date.now();
		if (ms <= 0) {
			delete rateLimitStore.byAccount[key];
			return;
		}
		const timer = setTimeout(() => {
			delete rateLimitStore.byAccount[key];
			autoClearTimers.delete(key);
		}, ms + 1000);
		autoClearTimers.set(key, timer);
	}
}

export function dismissRateLimit(engine: string, accountId: number): void {
	const key = getAccountKey(engine, accountId);
	cancelAutoClear(key);
	delete rateLimitStore.byAccount[key];
}
