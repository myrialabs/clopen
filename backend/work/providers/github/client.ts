/**
 * A small GitHub REST client — only what the Issues & PRs surface needs.
 *
 * No SDK. The surface makes about a dozen distinct calls, all of them plain
 * JSON over HTTPS, and an SDK would add a dependency whose transitive tree we
 * would then have to keep Bun-compatible (see the typebox and bson incidents)
 * for no capability we use.
 *
 * Three things this does that a bare `fetch` would not:
 *
 *  - Conditional requests. Every GET stores its ETag and replays it as
 *    `If-None-Match`. GitHub does not bill a 304 against the rate limit, so a
 *    panel that refreshes on focus costs almost nothing when nothing changed.
 *  - Rate-limit capture. The remaining budget is read off every response and
 *    surfaced in the panel footer, so hitting the limit is something the user
 *    saw coming rather than a sudden wall of 403s.
 *  - Honest error mapping. 401 is `needs_auth`, 404 on a repo we were told to
 *    read is `needs_config` (a fine-grained token that omits the repo returns
 *    404, not 403 — GitHub hides existence), and a 403 carrying
 *    `x-ratelimit-remaining: 0` is a rate limit, not a permission problem.
 */

import type { WorkRateLimit } from '$shared/types/work';
import { debug } from '$shared/utils/logger';

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_WEB_BASE = 'https://github.com';

/** Requests are capped so a hung enterprise instance cannot wedge a handler. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Cached ETags, keyed by token fingerprint + URL.
 *
 * Keyed by the token as well as the URL because two accounts can read the same
 * repo with different permissions and therefore get different bodies; a shared
 * entry would let one account's 304 hand the other account's body back.
 */
const etagCache = new Map<string, { etag: string; body: unknown }>();

/** Bounded so a long-lived process cannot grow one entry per issue ever viewed. */
const MAX_ETAG_ENTRIES = 500;

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'config' | 'rate-limit' | 'error'
	) {
		super(message);
		this.name = 'GitHubError';
	}
}

/**
 * Which kind of token this is, read off its prefix.
 *
 * This matters because the two kinds reach DIFFERENT repositories, and the API
 * reports both failures as an identical 404. A fine-grained token is scoped to
 * one resource owner: it can never see a repository owned by another person,
 * and an organisation's repositories only after an owner approves it. A classic
 * token with `repo` sees everything its user can, subject to SSO authorisation.
 *
 * Knowing which one is in play is the difference between "not found" and an
 * instruction the user can act on.
 */
export type GitHubTokenKind = 'fine-grained' | 'classic' | 'unknown';

export function tokenKindOf(token: string): GitHubTokenKind {
	if (token.startsWith('github_pat_')) return 'fine-grained';
	// ghp_ is a classic PAT; gho_/ghu_/ghs_ are OAuth and app tokens, which
	// behave like classic ones for the purposes of this explanation.
	if (/^gh[pousr]_/.test(token)) return 'classic';
	return 'unknown';
}

export interface GitHubCredentials {
	token: string;
	/** Enterprise Server root, e.g. `https://ghe.example.com`. Empty = github.com. */
	baseUrl?: string;
}

/** API root for these credentials. Enterprise Server hangs its API off `/api/v3`. */
export function apiBaseOf(credentials: GitHubCredentials): string {
	const raw = (credentials.baseUrl ?? '').trim().replace(/\/+$/, '');
	if (!raw) return GITHUB_API_BASE;
	if (/\/api\/v3$/.test(raw)) return raw;
	return `${raw}/api/v3`;
}

/** Web root, for the links the panel renders. */
export function webBaseOf(credentials: GitHubCredentials): string {
	const raw = (credentials.baseUrl ?? '').trim().replace(/\/+$/, '');
	if (!raw) return GITHUB_WEB_BASE;
	return raw.replace(/\/api\/v3$/, '');
}

/**
 * A token fingerprint for cache keys.
 *
 * The token itself must never be a map key: maps get inspected in a debugger,
 * dumped in a heap snapshot, and printed by a well-meaning log line. A short
 * non-reversible digest identifies the account just as well.
 */
function fingerprint(token: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(token);
	return hasher.digest('hex').slice(0, 12);
}

function parseRateLimit(headers: Headers): WorkRateLimit | null {
	const remaining = headers.get('x-ratelimit-remaining');
	const limit = headers.get('x-ratelimit-limit');
	if (remaining === null || limit === null) return null;

	const reset = headers.get('x-ratelimit-reset');
	return {
		remaining: Number(remaining),
		limit: Number(limit),
		resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null
	};
}

export interface GitHubResponse<T> {
	data: T;
	rateLimit: WorkRateLimit | null;
	/** Present when the response carried a `Link: rel="next"`. */
	nextUrl: string | null;
}

function parseNextLink(headers: Headers): string | null {
	const link = headers.get('link');
	if (!link) return null;
	const match = link.split(',').find((part) => /rel="next"/.test(part));
	if (!match) return null;
	const url = match.match(/<([^>]+)>/);
	return url ? url[1] : null;
}

/**
 * Map a failed response onto something the hub and the panel can act on.
 *
 * The GitHub message is kept because it is usually the most specific thing
 * anyone will see — "Resource not accessible by personal access token" names
 * the actual problem better than any wording we could invent.
 */
async function toError(response: Response): Promise<GitHubError> {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const body = await response.json() as { message?: unknown };
		if (typeof body.message === 'string' && body.message.trim()) message = body.message;
	} catch {
		// Non-JSON body — the status line is all we have.
	}

	if (response.status === 401) {
		return new GitHubError(`${message}. The token is invalid or was revoked.`, 401, 'auth');
	}
	if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
		const reset = response.headers.get('x-ratelimit-reset');
		const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'shortly';
		return new GitHubError(`GitHub rate limit reached. It resets at ${at}.`, 403, 'rate-limit');
	}
	if (response.status === 403) {
		return new GitHubError(`${message}. The token is missing a required permission.`, 403, 'config');
	}
	if (response.status === 404) {
		// A fine-grained token without access to a repo gets 404, not 403 —
		// GitHub will not confirm a private repo exists. So "not found" has to be
		// reported as a configuration problem, naming both possibilities.
		return new GitHubError(`${message}. The repository does not exist, or the token cannot see it.`, 404, 'config');
	}
	return new GitHubError(message, response.status, 'error');
}

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
	body?: unknown;
	/** Skip the ETag cache — used when a write must be observed immediately. */
	noCache?: boolean;
	/** Overrides the default `application/vnd.github+json`. */
	accept?: string;
}

/**
 * One request. `path` is either an API path (`/repos/x/y`) or an absolute URL,
 * which is how pagination follows a `Link` header without re-deriving the base.
 */
export async function githubRequest<T>(
	credentials: GitHubCredentials,
	path: string,
	options: RequestOptions = {}
): Promise<GitHubResponse<T>> {
	const url = path.startsWith('http') ? path : `${apiBaseOf(credentials)}${path}`;
	const method = options.method ?? 'GET';
	const cacheKey = `${fingerprint(credentials.token)}:${url}`;
	const cached = method === 'GET' && !options.noCache ? etagCache.get(cacheKey) : undefined;

	const headers: Record<string, string> = {
		Accept: options.accept ?? 'application/vnd.github+json',
		Authorization: `Bearer ${credentials.token}`,
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'clopen'
	};
	if (cached) headers['If-None-Match'] = cached.etag;
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers,
			...(options.body !== undefined && { body: JSON.stringify(options.body) }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new GitHubError(`Could not reach GitHub: ${detail}`, 0, 'error');
	}

	const rateLimit = parseRateLimit(response.headers);

	if (response.status === 304 && cached) {
		return { data: cached.body as T, rateLimit, nextUrl: parseNextLink(response.headers) };
	}

	if (!response.ok) throw await toError(response);

	// 204 (and any other empty body) is a legitimate success for the write paths.
	const text = await response.text();
	const data = (text ? JSON.parse(text) : null) as T;

	const etag = response.headers.get('etag');
	if (method === 'GET' && etag) {
		if (etagCache.size >= MAX_ETAG_ENTRIES) {
			// Cheapest possible eviction: the oldest insertion. The cache is a cost
			// optimisation, so a wrong eviction costs one request, never a wrong answer.
			const oldest = etagCache.keys().next();
			if (!oldest.done) etagCache.delete(oldest.value);
		}
		etagCache.set(cacheKey, { etag, body: data });
	}

	return { data, rateLimit, nextUrl: parseNextLink(response.headers) };
}

/**
 * Follow `Link: rel="next"` up to `maxPages`.
 *
 * Bounded on purpose: the panel shows a working list, not an archive, and an
 * unbounded follow against a repo with 4,000 open issues would spend the user's
 * entire hourly rate limit filling a list nobody scrolls.
 */
export async function githubPaged<T>(
	credentials: GitHubCredentials,
	path: string,
	maxPages = 3
): Promise<{ items: T[]; rateLimit: WorkRateLimit | null }> {
	const items: T[] = [];
	let next: string | null = path;
	let rateLimit: WorkRateLimit | null = null;

	for (let page = 0; page < maxPages && next; page += 1) {
		const response: GitHubResponse<T[]> = await githubRequest<T[]>(credentials, next);
		items.push(...(response.data ?? []));
		rateLimit = response.rateLimit ?? rateLimit;
		next = response.nextUrl;
	}

	return { items, rateLimit };
}

/** Drop cached ETags for one account, so the next read is unconditional. */
export function invalidateGitHubCache(token: string): void {
	const prefix = `${fingerprint(token)}:`;
	for (const key of etagCache.keys()) {
		if (key.startsWith(prefix)) etagCache.delete(key);
	}
	debug.log('work', 'Cleared GitHub response cache for one account');
}
