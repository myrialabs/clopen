/**
 * One request against a hosting service's REST API.
 *
 * GitHub has its own client (`backend/work/providers/github/client.ts`) because
 * it has ETag caching and a rate-limit footer worth keeping. GitLab, Gitea and
 * Bitbucket go through this smaller one: JSON over HTTPS, a timeout, and the
 * same honest error mapping — 401 means "sign in again", 403/404 mean "this
 * account cannot reach it", and anything else is reported verbatim.
 */

import type { WorkRateLimit } from '$shared/types/work';

const REQUEST_TIMEOUT_MS = 20_000;

export type HostErrorKind = 'auth' | 'config' | 'rate-limit' | 'conflict' | 'error';

export class HostApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: HostErrorKind
	) {
		super(message);
		this.name = 'HostApiError';
	}
}

export interface HostRequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	headers?: Record<string, string>;
	/** JSON body. Use `form` for `application/x-www-form-urlencoded`. */
	body?: unknown;
	form?: Record<string, string>;
	/** Accept a non-JSON body and return it as text. */
	text?: boolean;
}

export interface HostResponse<T> {
	data: T;
	headers: Headers;
	status: number;
}

/** The most specific message a failed response carries. */
async function messageOf(response: Response): Promise<string> {
	const fallback = response.statusText || `HTTP ${response.status}`;
	try {
		const text = await response.text();
		if (!text) return fallback;
		try {
			const body = JSON.parse(text) as Record<string, unknown>;
			// GitLab: { message } or { error, error_description }. Gitea: { message }.
			// Bitbucket: { error: { message } }.
			const nested = body.error as { message?: unknown } | string | undefined;
			const candidates = [
				body.message,
				body.error_description,
				typeof nested === 'object' ? nested?.message : nested
			];
			for (const candidate of candidates) {
				if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
				if (candidate && typeof candidate === 'object') return JSON.stringify(candidate);
			}
			return fallback;
		} catch {
			return text.length < 300 ? text : fallback;
		}
	} catch {
		return fallback;
	}
}

export async function toHostError(response: Response, service: string): Promise<HostApiError> {
	const message = await messageOf(response);
	if (response.status === 401) {
		return new HostApiError(`${message}. The ${service} credential is invalid, expired or was revoked.`, 401, 'auth');
	}
	if (response.status === 429) {
		return new HostApiError(`${service} is rate limiting requests. Try again in a minute.`, 429, 'rate-limit');
	}
	if (response.status === 403) {
		return new HostApiError(`${message}. The ${service} account is missing a permission this needs.`, 403, 'config');
	}
	if (response.status === 404) {
		return new HostApiError(`${message}. It does not exist, or this ${service} account cannot see it.`, 404, 'config');
	}
	if (response.status === 409 || response.status === 422) {
		return new HostApiError(message, response.status, 'conflict');
	}
	return new HostApiError(message, response.status, 'error');
}

export async function hostRequest<T>(
	service: string,
	url: string,
	options: HostRequestOptions = {}
): Promise<HostResponse<T>> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'User-Agent': 'clopen',
		...options.headers
	};
	let body: string | undefined;
	if (options.form) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(options.form).toString();
	} else if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(options.body);
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: options.method ?? 'GET',
			headers,
			...(body !== undefined && { body }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new HostApiError(`Could not reach ${service}: ${detail}`, 0, 'error');
	}

	if (!response.ok) throw await toHostError(response, service);

	const text = await response.text();
	if (options.text) return { data: text as T, headers: response.headers, status: response.status };
	let data: T;
	try {
		data = (text ? JSON.parse(text) : null) as T;
	} catch {
		throw new HostApiError(`${service} answered with something that is not JSON`, response.status, 'error');
	}
	return { data, headers: response.headers, status: response.status };
}

/** GitLab-style rate limit headers, which Gitea mirrors. Null when absent. */
export function rateLimitFrom(headers: Headers): WorkRateLimit | null {
	const remaining = headers.get('ratelimit-remaining') ?? headers.get('x-ratelimit-remaining');
	const limit = headers.get('ratelimit-limit') ?? headers.get('x-ratelimit-limit');
	if (remaining === null || limit === null) return null;
	const reset = headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset');
	return {
		remaining: Number(remaining),
		limit: Number(limit),
		resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null
	};
}

/** Run `work` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index]!);
		}
	});
	await Promise.all(runners);
	return results;
}

/** Wait, then try again until `check` returns a value or the deadline passes. */
export async function waitFor<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs = 1500): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check().catch(() => null);
		if (value !== null) return value;
		await Bun.sleep(intervalMs);
	}
	return null;
}
