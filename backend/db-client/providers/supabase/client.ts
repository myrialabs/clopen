/**
 * A small Supabase Management API client — only what DB Client needs.
 *
 * No SDK, for the reason the Vercel and GitHub clients have none: this is a
 * handful of plain JSON calls, and an SDK would add a dependency tree we then
 * have to keep Bun-compatible for no capability we use.
 *
 * Every path in this file was read out of the published OpenAPI document at
 * `https://api.supabase.com/api/v1-json` rather than inferred from a sibling.
 * Two things there are worth knowing before changing anything:
 *
 *  - `POST /v1/projects/{ref}/database/query` exists and is marked BETA. It is
 *    deliberately unused: everything inside the database is read through the
 *    Postgres connection DB Client already holds, which keeps a `supabase start`
 *    stack working without an access token and keeps us off a beta endpoint for
 *    queries we can make directly.
 *  - There is NO endpoint that reads a project's database password back.
 *    `/v1/projects/{ref}/database/password` is PATCH-only, by design. That single
 *    fact is why a link stores a password of its own.
 */

const SUPABASE_API_BASE = 'https://api.supabase.com';

/**
 * Two budgets, the same split the Vercel client settled on. A read answers
 * quickly; generating TypeScript types for a large schema does not, and
 * aborting it mid-flight reports a timeout for work the server completed.
 */
const READ_TIMEOUT_MS = 20_000;
const SLOW_TIMEOUT_MS = 120_000;

export class SupabaseError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'config' | 'rate-limit' | 'error'
	) {
		super(message);
		this.name = 'SupabaseError';
	}
}

export interface SupabaseCredentials {
	accessToken: string;
}

/**
 * Classic or scoped, read from the prefix.
 *
 * Supabase prefixes a scoped personal access token `sbp_fc` and a classic
 * full-access one plain `sbp_`. That one character of information is worth a
 * great deal, because a scoped token missing a permission fails with an
 * undecorated "Forbidden" — the same undiagnosable shape GitHub's fine-grained
 * tokens produced in `Task 2`, and answered the same way: read the prefix and
 * name the likely cause rather than repeating the provider's word for it.
 */
export function tokenKindOf(token: string): 'scoped' | 'classic' {
	return token.startsWith('sbp_fc') ? 'scoped' : 'classic';
}

/** Which permission a 403 on a given path most likely needs. */
function missingScopeHint(path: string): string | null {
	if (path.startsWith('/v1/organizations/')) return 'Organization Settings (Read)';
	if (path === '/v1/organizations') return 'Organizations (Read)';
	if (path === '/v1/projects') return 'Organization Projects (Read-write) to create, Projects (account-wide) Read to list';
	if (path.includes('/types/typescript')) return 'Database (Read)';
	if (path.includes('/functions')) return 'Edge Functions (Read)';
	if (path.includes('/advisors/')) return 'Project Settings (Read)';
	if (path.includes('/config/database/pooler')) return 'Project Settings (Read)';
	return null;
}

/**
 * Map a failed response onto something the hub and the panel can act on.
 *
 * Supabase's own message is kept: it is the most specific thing anyone will
 * see. The classification is ours, because the hub's status strip understands
 * four states and no more.
 */
async function toError(
	response: Response,
	context: { path: string; token: string }
): Promise<SupabaseError> {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const body = await response.json() as { message?: unknown; error?: unknown; msg?: unknown };
		for (const candidate of [body.message, body.error, body.msg]) {
			if (typeof candidate === 'string' && candidate.trim()) {
				message = candidate;
				break;
			}
		}
	} catch {
		// Non-JSON body — the status line is all we have.
	}

	if (response.status === 401) {
		return new SupabaseError(
			`${message}. The access token is invalid or was revoked — create a new one at supabase.com/dashboard/account/tokens.`,
			401,
			'auth'
		);
	}
	if (response.status === 403) {
		// The most common cause by far, and the one the provider never names.
		// A classic token's 403 really is about membership; a scoped token's is
		// almost always a permission that was not ticked when it was created.
		const scope = missingScopeHint(context.path);
		const detail = tokenKindOf(context.token) === 'scoped'
			? `This is a SCOPED token${scope ? `, and this call needs ${scope}` : ''}. Scoped tokens only carry the permissions picked when they were created — regenerate it with that permission, or use a classic token.`
			: "This token's user does not have access here — a token belongs to one Supabase user, and organisation access follows that user's membership.";
		return new SupabaseError(`${message}. ${detail}`, 403, 'config');
	}
	if (response.status === 404) {
		return new SupabaseError(
			`${message}. The project does not exist, or this token cannot see it.`,
			404,
			'config'
		);
	}
	if (response.status === 429) {
		return new SupabaseError('Supabase rate limit reached. Try again shortly.', 429, 'rate-limit');
	}
	return new SupabaseError(message, response.status, 'error');
}

/**
 * What the Management API says about how much budget is left.
 *
 * Supabase does not document these, but every response carries them — verified
 * against a live account: `x-ratelimit-limit: 120`, `x-ratelimit-remaining`,
 * and `x-ratelimit-reset: 60`. The budget is per MINUTE, not per hour.
 *
 * `x-ratelimit-reset` is SECONDS FROM NOW, not an epoch timestamp. GitHub and
 * Vercel both send an epoch there, and reading this one the same way dated
 * every reset to January 1970 — the footer would have said "resets 07:01:00"
 * and nobody would have known why.
 *
 * Absent means "not reported", never "none left", so a missing header shows
 * nothing rather than an alarming zero.
 */
export interface SupabaseRateLimit {
	remaining: number;
	limit: number;
	resetAt: string | null;
}

/**
 * Last reading PER TOKEN, not per process.
 *
 * The limit is counted per Supabase user, so two connected accounts have two
 * separate budgets and one global figure would attribute one account's usage to
 * the other. The token is used as the map key and nothing more — it never
 * leaves this module, and it is already in memory on the object being passed.
 */
const rateLimits = new Map<string, SupabaseRateLimit>();

/** The most recent rate-limit reading for one account, for the surface's footer. */
export function getSupabaseRateLimit(credentials: SupabaseCredentials): SupabaseRateLimit | null {
	return rateLimits.get(credentials.accessToken) ?? null;
}

/**
 * Take a reading if this account has never produced one.
 *
 * The footer is rendered from the connection context, and resolving that
 * context touches no Management API at all — the default tab is pure SQL — so
 * on a fresh server the quota had nothing to show and simply never appeared.
 * One cheap request the first time an account is looked at fixes that for the
 * process's lifetime; every later call refreshes the reading for free, because
 * the headers ride on responses we were making anyway.
 *
 * Failure is ignored: this exists to populate a footer, and nothing depends on
 * it succeeding.
 */
export async function primeSupabaseRateLimit(
	credentials: SupabaseCredentials,
	ref: string
): Promise<void> {
	if (rateLimits.has(credentials.accessToken)) return;
	try {
		await supabaseRequest(credentials, `/v1/projects/${encodeURIComponent(ref)}`);
	} catch {
		// A token that cannot read the project still cannot report a budget.
	}
}

function readRateLimit(token: string, headers: Headers): void {
	const remaining = headers.get('x-ratelimit-remaining');
	const limit = headers.get('x-ratelimit-limit');
	if (remaining === null || limit === null) return;

	const remainingValue = Number(remaining);
	const limitValue = Number(limit);
	if (!Number.isFinite(remainingValue) || !Number.isFinite(limitValue)) return;

	const reset = headers.get('x-ratelimit-reset');
	const resetValue = reset === null ? NaN : Number(reset);
	rateLimits.set(token, {
		remaining: remainingValue,
		limit: limitValue,
		// A DURATION in seconds, resolved against now. See the note above: reading
		// it as an epoch is the mistake this comment exists to stop.
		resetAt: Number.isFinite(resetValue) ? new Date(Date.now() + resetValue * 1000).toISOString() : null
	});
}

export interface SupabaseRequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	query?: Record<string, string | number | undefined | null>;
	timeoutMs?: number;
}

function buildUrl(path: string, query?: SupabaseRequestOptions['query']): string {
	const url = new URL(`${SUPABASE_API_BASE}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}

export async function supabaseRequest<T>(
	credentials: SupabaseCredentials,
	path: string,
	options: SupabaseRequestOptions = {}
): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.accessToken}`,
		'User-Agent': 'clopen'
	};
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';

	let response: Response;
	try {
		response = await fetch(buildUrl(path, options.query), {
			method,
			headers,
			...(options.body !== undefined && { body: JSON.stringify(options.body) }),
			signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS)
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SupabaseError(`Could not reach Supabase: ${detail}`, 0, 'error');
	}

	// Read before the status check: a 429 is precisely when the remaining count
	// is worth knowing.
	readRateLimit(credentials.accessToken, response.headers);
	if (!response.ok) throw await toError(response, { path, token: credentials.accessToken });

	const text = await response.text();
	return (text ? JSON.parse(text) : null) as T;
}

/** The budget for calls that do real work upstream, such as type generation. */
export const SUPABASE_SLOW_TIMEOUT_MS = SLOW_TIMEOUT_MS;
