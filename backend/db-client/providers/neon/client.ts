/**
 * A small Neon API client — the vendor's home in this codebase.
 *
 * No SDK, for the reason the Supabase, Vercel and GitHub clients have none:
 * this is a handful of plain JSON calls, and an SDK would add a dependency tree
 * we then have to keep Bun-compatible for no capability we use.
 *
 * NEON SERVES TWO SURFACES from one credential — DB Client (`database`) and the
 * worktree manager (`worktree-branching`) — so this module lives here, with the
 * database adapter, and `backend/worktrees/branching/providers/neon.ts` imports
 * it rather than opening a second one. Two clients would mean two independent
 * views of the same account's rate budget and two places to fix a 403, which is
 * exactly the duplication the account layer exists to prevent.
 *
 * Every path below was read out of the published OpenAPI document at
 * `https://dfv3qgd2ykmrx.cloudfront.net/api_spec/release/v2.json` rather than
 * inferred from a sibling. Four things there are worth knowing before changing
 * anything:
 *
 *  - `POST /projects/{id}/branches` returns `connection_uris` OPTIONALLY. The
 *    document is explicit: "When creating a branch from a parent with more than
 *    one role or database, the response body does not include a connection
 *    URI." So the create path must fall back to `GET /connection_uri`, which is
 *    not an optimisation but a correctness requirement.
 *  - A branch created WITHOUT `endpoints` has no compute at all and refuses
 *    every connection. `endpoints: [{ type: 'read_write' }]` is mandatory here.
 *  - `GET /projects/{id}/branches/{bid}/roles/{role}/reveal_password` exists.
 *    Neon hands the password back, which is why linking a Neon database asks
 *    for no secret at all — the opposite of Supabase, whose
 *    `/database/password` is PATCH-only by design.
 *  - `expires_at` / branch TTL is EARLY ACCESS ONLY. It would be the perfect
 *    safety net for a leaked branch and it is deliberately unused: sending it
 *    would fail for every account outside that programme, so orphan detection
 *    is Clopen's own job (see `backend/worktrees/branching/service.ts`).
 *
 * There is NO `POST /organizations`. Neon organisations cannot be created
 * through the API at all, so this adapter offers no `createGroup` — absent
 * rather than faked, the rule `Task 4` settled on for Supabase organisations.
 */

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

/**
 * Two budgets, the same split the Supabase and Vercel clients settled on. A
 * read answers quickly; provisioning a project does not, and aborting it
 * mid-flight reports a timeout for work the server completed.
 */
const READ_TIMEOUT_MS = 20_000;
const SLOW_TIMEOUT_MS = 120_000;

export class NeonError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly kind: 'auth' | 'config' | 'quota' | 'rate-limit' | 'error'
	) {
		super(message);
		this.name = 'NeonError';
	}
}

export interface NeonCredentials {
	apiKey: string;
}

/** Which permission or plan limit a refusal on a given path most likely means. */
function refusalHint(path: string, method: string): string | null {
	if (method === 'POST' && path.endsWith('/branches')) {
		return "Neon caps how many branches a project may have, and the cap is part of the plan. Delete a branch you no longer need, or check the project's branch limit.";
	}
	if (method === 'POST' && path === '/projects') {
		return 'Neon caps how many projects an account may have. Delete one you no longer need, or pick an organisation with room.';
	}
	if (path.startsWith('/organizations/')) {
		return 'An organisation-scoped API key only reaches its own organisation — check which one this key was created in.';
	}
	return null;
}

/**
 * Whether a message is Neon's "you did not say which organisation".
 *
 * `/projects` is organisation-scoped and refuses a call that omits `org_id`.
 * The adapter now always supplies one, so reaching this means the organisation
 * lookup itself came back empty — which is a different problem from the one
 * Neon's own wording describes, and pointing the user at their organisation
 * settings page would send them somewhere that cannot help.
 */
export function isMissingOrgError(error: unknown): boolean {
	return error instanceof NeonError && /org_id is required/i.test(error.message);
}

/**
 * Map a failed response onto something the hub and the manager can act on.
 *
 * Neon's own message is kept: it is the most specific thing anyone will see.
 * The classification is ours, because the hub's status strip understands four
 * states and no more.
 */
async function toError(
	response: Response,
	context: { path: string; method: string }
): Promise<NeonError> {
	let message = response.statusText || `HTTP ${response.status}`;
	try {
		const body = await response.json() as { message?: unknown; error?: unknown; code?: unknown };
		for (const candidate of [body.message, body.error]) {
			if (typeof candidate === 'string' && candidate.trim()) {
				message = candidate;
				break;
			}
		}
	} catch {
		// Non-JSON body — the status line is all we have.
	}

	// A 400 here is Neon telling us a required parameter is missing or wrong —
	// `org_id` on `/projects` is the one that actually happened. That is a
	// CONFIGURATION problem, not a transient failure, so it must not land in the
	// hub's status strip as a red "error" with no guidance: `needs_config` is
	// what tells the user there is something to fix rather than to retry.
	if (response.status === 400) {
		return new NeonError(message, 400, 'config');
	}
	if (response.status === 401) {
		return new NeonError(
			`${message}. The API key is invalid or was revoked — create a new one at console.neon.tech/app/settings/api-keys.`,
			401,
			'auth'
		);
	}
	if (response.status === 403) {
		const hint = refusalHint(context.path, context.method);
		return new NeonError(
			`${message}.${hint ? ` ${hint}` : ' This key does not have access here.'}`,
			403,
			'config'
		);
	}
	if (response.status === 404) {
		return new NeonError(`${message}. It does not exist, or this key cannot see it.`, 404, 'config');
	}
	// 422 is what Neon answers when a limit is reached — a branch cap, a project
	// cap — and it is a different problem from a permission, so it gets its own
	// kind rather than being flattened into "config".
	if (response.status === 422) {
		const hint = refusalHint(context.path, context.method);
		return new NeonError(`${message}.${hint ? ` ${hint}` : ''}`, 422, 'quota');
	}
	if (response.status === 429) {
		return new NeonError('Neon rate limit reached. Try again shortly.', 429, 'rate-limit');
	}
	return new NeonError(message, response.status, 'error');
}

/**
 * What Neon says about how much budget is left.
 *
 * Read defensively and reported as ABSENT when the headers are not there. Neon
 * documents rate limits but not the headers that carry them, so unlike the
 * Supabase client — where every header name was confirmed against a live
 * account — nothing here is asserted. Absent means NOT REPORTED, never zero: a
 * footer that invents a quota is worse than one that shows none.
 */
export interface NeonRateLimit {
	remaining: number;
	limit: number;
	resetAt: string | null;
}

/**
 * Last reading PER KEY, not per process.
 *
 * Neon counts per API key, so two connected accounts have two budgets and one
 * global figure would attribute one account's usage to the other — the same
 * reason the Supabase client keys on its token.
 */
const rateLimits = new Map<string, NeonRateLimit>();

export function getNeonRateLimit(credentials: NeonCredentials): NeonRateLimit | null {
	return rateLimits.get(credentials.apiKey) ?? null;
}

function readRateLimit(key: string, headers: Headers): void {
	const remaining = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining');
	const limit = headers.get('x-ratelimit-limit') ?? headers.get('ratelimit-limit');
	if (remaining === null || limit === null) return;

	const remainingValue = Number(remaining);
	const limitValue = Number(limit);
	if (!Number.isFinite(remainingValue) || !Number.isFinite(limitValue)) return;

	const reset = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
	const resetValue = reset === null ? NaN : Number(reset);
	// Read as a DURATION in seconds, the interpretation that is safe when it is
	// wrong: a duration misread as an epoch dates the reset to 1970, which is the
	// bug the Supabase footer shipped with. An epoch misread as a duration only
	// pushes the label further into the future, which reads as "not soon".
	rateLimits.set(key, {
		remaining: remainingValue,
		limit: limitValue,
		resetAt: Number.isFinite(resetValue) ? new Date(Date.now() + resetValue * 1000).toISOString() : null
	});
}

export interface NeonRequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	query?: Record<string, string | number | boolean | undefined | null>;
	timeoutMs?: number;
	/**
	 * Try once more when the CONNECTION failed rather than the request.
	 *
	 * Defaults to true for GET and false for everything else, and the default is
	 * the whole point: a dropped socket says nothing about whether the server
	 * acted. Re-reading is free; re-sending a `POST /projects` would provision a
	 * second real database and bill for it.
	 */
	retryOnTransport?: boolean;
}

/** True for a failure that happened before Neon answered at all. */
export function isTransportError(error: unknown): boolean {
	return error instanceof NeonError && error.status === 0;
}

/**
 * A network failure, said once and without the runtime's debugging aside.
 *
 * Bun appends "For more information, pass `verbose: true` in the second
 * argument to fetch()" to a closed socket, which reached the user inside a
 * dialog about creating a database and told them to edit Clopen's source.
 */
function transportMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const cleaned = raw.replace(/\s*For more information, pass[\s\S]*$/i, '').trim();
	if (/timed? out|timeout|abort/i.test(cleaned)) {
		return 'Neon did not answer in time — check the dashboard before trying again, in case it went through.';
	}
	return `Could not reach Neon: ${cleaned || 'the connection was closed'}.`;
}

function buildUrl(path: string, query?: NeonRequestOptions['query']): string {
	const url = new URL(`${NEON_API_BASE}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}

export async function neonRequest<T>(
	credentials: NeonCredentials,
	path: string,
	options: NeonRequestOptions = {}
): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.apiKey}`,
		Accept: 'application/json',
		'User-Agent': 'clopen'
	};
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';

	const url = buildUrl(path, options.query);
	const send = (): Promise<Response> =>
		fetch(url, {
			method,
			headers,
			...(options.body !== undefined && { body: JSON.stringify(options.body) }),
			signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS)
		});

	const mayRetry = options.retryOnTransport ?? method === 'GET';

	let response: Response;
	try {
		response = await send();
	} catch (first) {
		if (!mayRetry) throw new NeonError(transportMessage(first), 0, 'error');
		try {
			response = await send();
		} catch (second) {
			throw new NeonError(transportMessage(second), 0, 'error');
		}
	}

	// Read before the status check: a 429 is precisely when the remaining count
	// is worth knowing.
	readRateLimit(credentials.apiKey, response.headers);
	if (!response.ok) throw await toError(response, { path, method });

	const text = await response.text();
	return (text ? JSON.parse(text) : null) as T;
}

/** The budget for calls that do real work upstream — provisioning a project. */
export const NEON_SLOW_TIMEOUT_MS = SLOW_TIMEOUT_MS;
