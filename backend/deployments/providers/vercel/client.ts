/**
 * A small Vercel REST client — only what the Deployments surface needs.
 *
 * No SDK, for the reason the GitHub client has none: this surface makes about a
 * dozen plain JSON calls, and an SDK would add a dependency whose transitive
 * tree we then have to keep Bun-compatible (see the typebox and bson incidents)
 * for no capability we use.
 *
 * Vercel's API is versioned PER ENDPOINT, not globally, and the versions are
 * not interchangeable — listing projects is `/v10/projects` while reading one
 * is `/v9/projects/{id}`, and rollback and promote sit on `/v1` and `/v10`
 * respectively. Every path in this file was checked against the published
 * OpenAPI document rather than inferred from a sibling, because guessing the
 * version yields a 404 that reads exactly like a permission problem.
 *
 * `teamId` travels on nearly every call. A token reaches several teams, and a
 * request without the team simply does not see that team's projects — another
 * failure that arrives as an empty list rather than an error.
 */

import type { DeployRateLimit } from '$shared/types/deployments';

export const VERCEL_API_BASE = 'https://api.vercel.com';

/**
 * Requests are capped so a hung API cannot wedge a handler.
 *
 * Two budgets, because the work behind these calls differs by an order of
 * magnitude. A read answers in under a second. Linking a repository, creating a
 * project or queueing a build makes Vercel talk to a git host and provision
 * things, and 20 seconds is not unusual — the first version aborted those
 * mid-flight and reported a timeout for an operation that then completed
 * server-side, which is the worst of both: no result, and the change happened
 * anyway.
 */
const READ_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 120_000;

export class VercelError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'config' | 'rate-limit' | 'error'
	) {
		super(message);
		this.name = 'VercelError';
	}
}

export interface VercelCredentials {
	token: string;
}

function parseRateLimit(headers: Headers): DeployRateLimit | null {
	const remaining = headers.get('x-ratelimit-remaining');
	const limit = headers.get('x-ratelimit-limit');
	if (remaining === null || limit === null) return null;

	const reset = headers.get('x-ratelimit-reset');
	return {
		remaining: Number(remaining),
		limit: Number(limit),
		// Vercel reports the reset as epoch seconds, like GitHub does.
		resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null
	};
}

/**
 * Map a failed response onto something the hub and the panel can act on.
 *
 * Vercel's own message is kept because it is the most specific thing anyone
 * will see — "Not authorized to access this resource" names the problem better
 * than any wording we could invent. The classification is ours, because the
 * hub's status strip only understands four states.
 */
async function toError(response: Response): Promise<VercelError> {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const body = await response.json() as { error?: { message?: unknown; code?: unknown } };
		if (typeof body.error?.message === 'string' && body.error.message.trim()) {
			message = body.error.message;
		}
	} catch {
		// Non-JSON body — the status line is all we have.
	}

	if (response.status === 401) {
		return new VercelError(`${message}. The token is invalid or was revoked.`, 401, 'auth');
	}
	if (response.status === 429) {
		const reset = response.headers.get('x-ratelimit-reset');
		const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'shortly';
		return new VercelError(`Vercel rate limit reached. It resets at ${at}.`, 429, 'rate-limit');
	}
	if (response.status === 403) {
		return new VercelError(`${message}. The token cannot reach this resource — check its scope, and whether the project belongs to a team.`, 403, 'config');
	}
	if (response.status === 404) {
		// A token scoped to a personal account gets 404 for a team's project
		// rather than 403, so "not found" has to name both possibilities.
		return new VercelError(`${message}. The project does not exist, or this token cannot see it — a project owned by a team needs the team's id.`, 404, 'config');
	}
	return new VercelError(message, response.status, 'error');
}

export interface VercelResponse<T> {
	data: T;
	rateLimit: DeployRateLimit | null;
}

export interface VercelRequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	/**
	 * Appended verbatim.
	 *
	 * `teamId` belongs here on nearly every call — but NOT on all of them:
	 * `/v1/integrations/git-namespaces` rejects it with a 400, because
	 * namespaces belong to the signed-in user rather than to a team.
	 */
	query?: Record<string, string | number | undefined | null>;
	/** Overrides the budget chosen from the method. */
	timeoutMs?: number;
}

function buildUrl(path: string, query?: VercelRequestOptions['query']): string {
	const url = new URL(path.startsWith('http') ? path : `${VERCEL_API_BASE}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}

export async function vercelRequest<T>(
	credentials: VercelCredentials,
	path: string,
	options: VercelRequestOptions = {}
): Promise<VercelResponse<T>> {
	const method = options.method ?? 'GET';
	const timeout = options.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.token}`,
		'User-Agent': 'clopen'
	};
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';

	let response: Response;
	try {
		response = await fetch(buildUrl(path, options.query), {
			method,
			headers,
			...(options.body !== undefined && { body: JSON.stringify(options.body) }),
			signal: AbortSignal.timeout(timeout)
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new VercelError(`Could not reach Vercel: ${detail}`, 0, 'error');
	}

	const rateLimit = parseRateLimit(response.headers);
	if (!response.ok) throw await toError(response);

	// An empty body is a legitimate success on the action paths.
	const text = await response.text();
	return { data: (text ? JSON.parse(text) : null) as T, rateLimit };
}

/**
 * Open the build-log stream.
 *
 * Returned raw rather than parsed because the caller pumps it: `follow=1` makes
 * this response never end on its own, so it cannot go through `vercelRequest`,
 * which reads the body to completion. The abort signal is the only way to close
 * it, which is why it is required rather than optional.
 */
export async function vercelEventStream(
	credentials: VercelCredentials,
	deploymentId: string,
	options: { teamId: string | null; signal: AbortSignal }
): Promise<Response> {
	const url = buildUrl(`/v3/deployments/${encodeURIComponent(deploymentId)}/events`, {
		follow: 1,
		builds: 1,
		limit: -1,
		teamId: options.teamId ?? undefined
	});

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${credentials.token}`,
			// The endpoint answers with a JSON array when it is not following and
			// a newline-delimited stream when it is. Asking for the stream shape
			// explicitly keeps the parser honest about which one arrived.
			Accept: 'application/stream+json',
			'User-Agent': 'clopen'
		},
		signal: options.signal
	});

	if (!response.ok) throw await toError(response);
	return response;
}
