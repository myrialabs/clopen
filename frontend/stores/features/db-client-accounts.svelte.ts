/**
 * Account-backed connections, and the Supabase surface on top of them.
 *
 * Kept out of `db-client.svelte.ts` deliberately. That store is the panel's
 * core — connections, schema, per-connection views — and every screen in DB
 * Client reads it. This is a second concern with its own lifecycle: it is
 * empty for most installs, its data is per-connection rather than global, and
 * folding it in would grow the file every screen already depends on.
 *
 * Per-connection caches are keyed by connection id and dropped when a
 * connection goes away, so switching between two Supabase projects never shows
 * the other one's policies for a frame.
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	DbAccountLinkInfo,
	DbProviderCreateOptions,
	DbProviderInfo,
	DbRemoteDatabase,
	SupabaseAuthUsersPage,
	SupabaseBucket,
	SupabaseConnectionContext,
	SupabaseEdgeFunction,
	SupabaseMigrationsReport,
	SupabaseRateLimitInfo,
	SupabaseRlsReport,
	SupabaseTypesResult
} from '$shared/types/db-client';

/** An integration account that can supply database connections. */
export interface DbClientAccountInfo {
	accountId: string;
	provider: string;
	label: string;
	status: string;
}

/** What the panel knows about a connection's Supabase-ness. */
export interface SupabasePanelContext extends SupabaseConnectionContext {
	hasLocalProject: boolean;
	hasAccount: boolean;
	accountLabel: string | null;
	/** Null when the API has not reported one — never rendered as zero. */
	rateLimit: SupabaseRateLimitInfo | null;
}

export interface DetectedLocalStack {
	ref: string;
	configPath: string;
	dbPort: number;
	alreadyAdded: boolean;
}

/** One tab's data, plus whether it is loading and why it last failed. */
interface Cell<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
}

function cell<T>(): Cell<T> {
	return { data: null, loading: false, error: null };
}

interface AccountsState {
	providers: DbProviderInfo[];
	accounts: DbClientAccountInfo[];
	links: DbAccountLinkInfo[];
	loaded: boolean;
	loading: boolean;
	error: string | null;

	/** Remote databases per account, fetched when the picker opens. */
	remote: Record<string, Cell<DbRemoteDatabase[]>>;

	/**
	 * Supabase, per connection id.
	 *
	 * A MISSING key and a `null` mean different things: missing is "not asked
	 * yet", null is "asked, and this is not a Supabase connection". Collapsing
	 * them made the Supabase tab bounce away to Overview for a frame on every
	 * open, before the answer had arrived.
	 */
	context: Record<string, SupabasePanelContext | null>;
	migrations: Record<string, Cell<SupabaseMigrationsReport>>;
	rls: Record<string, Cell<SupabaseRlsReport>>;
	buckets: Record<string, Cell<SupabaseBucket[]>>;
	authUsers: Record<string, Cell<SupabaseAuthUsersPage>>;
	functions: Record<string, Cell<SupabaseEdgeFunction[]>>;

	/** The local stack detected in the current project, if any. */
	localStack: DetectedLocalStack | null;
}

const state = $state<AccountsState>({
	providers: [],
	accounts: [],
	links: [],
	loaded: false,
	loading: false,
	error: null,
	remote: {},
	context: {},
	migrations: {},
	rls: {},
	buckets: {},
	authUsers: {},
	functions: {},
	localStack: null
});

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Run a fetch into a keyed cell.
 *
 * The generation guard is the lesson from the Issues list: two requests for the
 * same cell can land out of order, and the slower first one overwriting the
 * newer answer leaves the panel showing data for the wrong connection.
 */
const generations = new Map<string, number>();

/**
 * Which keys have already been asked for. A PLAIN Set, never `$state`.
 *
 * This is the fix for `effect_update_depth_exceeded`, and the reason it has to
 * be non-reactive is the whole bug. Every one of these fetches WRITES its cell —
 * `loading: true` goes in synchronously — so an effect that decides whether to
 * fetch by READING that same cell subscribes to what it is about to change, and
 * re-runs itself forever. The picker did exactly that and hammered Supabase into
 * a rate limit inside a second; the connection-context effect did it worse,
 * because a plain Postgres connection resolves to `null`, so its guard was never
 * satisfied and it looped for every non-Supabase row.
 *
 * Keeping the "have I asked yet" answer OUT of the reactive graph is what breaks
 * the cycle: the effect reads only its own id, and this Set decides the rest.
 * Same shape as the fix for the shared-counter effect loop elsewhere in the app.
 */
const requested = new Set<string>();

/** Fire `run` the first time a key is seen, and never again on its own. */
function once(key: string, run: () => void): void {
	if (requested.has(key)) return;
	requested.add(key);
	run();
}

/**
 * Forget a key so the next `ensure` fetches again.
 *
 * Used by the explicit refresh paths and by anything that invalidates a cell —
 * a failed fetch deliberately does NOT forget itself, or a provider that is
 * down turns one mounted tab into an unbounded retry loop.
 */
function forgetKey(key: string): void {
	requested.delete(key);
}

async function intoCell<T>(
	bucket: Record<string, Cell<T>>,
	key: string,
	run: () => Promise<T>,
	fallbackMessage: string
): Promise<T | null> {
	const generation = (generations.get(key) ?? 0) + 1;
	generations.set(key, generation);

	bucket[key] = { data: bucket[key]?.data ?? null, loading: true, error: null };
	try {
		const data = await run();
		if (generations.get(key) !== generation) return data;
		bucket[key] = { data, loading: false, error: null };
		return data;
	} catch (error) {
		if (generations.get(key) === generation) {
			bucket[key] = { data: bucket[key]?.data ?? null, loading: false, error: messageOf(error, fallbackMessage) };
		}
		debug.error('db-client', `${fallbackMessage}:`, error);
		return null;
	}
}

export const dbAccountsStore = {
	get providers(): DbProviderInfo[] {
		return state.providers;
	},
	get accounts(): DbClientAccountInfo[] {
		return state.accounts;
	},
	get links(): DbAccountLinkInfo[] {
		return state.links;
	},
	get loaded(): boolean {
		return state.loaded;
	},
	get loading(): boolean {
		return state.loading;
	},
	get error(): string | null {
		return state.error;
	},
	get localStack(): DetectedLocalStack | null {
		return state.localStack;
	},

	remoteFor(accountId: string): Cell<DbRemoteDatabase[]> {
		return state.remote[accountId] ?? cell<DbRemoteDatabase[]>();
	},
	/** `undefined` while unasked, `null` once known not to be Supabase. */
	contextFor(connectionId: string): SupabasePanelContext | null | undefined {
		return state.context[connectionId];
	},
	migrationsFor(connectionId: string): Cell<SupabaseMigrationsReport> {
		return state.migrations[connectionId] ?? cell<SupabaseMigrationsReport>();
	},
	rlsFor(connectionId: string): Cell<SupabaseRlsReport> {
		return state.rls[connectionId] ?? cell<SupabaseRlsReport>();
	},
	bucketsFor(connectionId: string): Cell<SupabaseBucket[]> {
		return state.buckets[connectionId] ?? cell<SupabaseBucket[]>();
	},
	authUsersFor(connectionId: string): Cell<SupabaseAuthUsersPage> {
		return state.authUsers[connectionId] ?? cell<SupabaseAuthUsersPage>();
	},
	functionsFor(connectionId: string): Cell<SupabaseEdgeFunction[]> {
		return state.functions[connectionId] ?? cell<SupabaseEdgeFunction[]>();
	},

	/** The link behind a connection, so the badge can offer to edit it. */
	linkForConnection(connectionId: string): DbAccountLinkInfo | null {
		return state.links.find((link) => link.connectionId === connectionId) ?? null;
	},

	/**
	 * Providers, accounts and links.
	 *
	 * Admin-gated on the server, so a member gets an error here. That is not
	 * surfaced as a failure: the entry points this data feeds simply do not
	 * appear, which is the honest rendering of "you cannot connect accounts".
	 */
	async load(options: { force?: boolean } = {}): Promise<void> {
		requested.add('providers');
		if (state.loading) return;
		if (state.loaded && !options.force) return;
		state.loading = true;
		try {
			const result = await ws.http('db-client:providers', {}) as {
				providers: DbProviderInfo[];
				accounts: DbClientAccountInfo[];
				links: DbAccountLinkInfo[];
			};
			state.providers = result.providers ?? [];
			state.accounts = result.accounts ?? [];
			state.links = result.links ?? [];
			state.error = null;
		} catch (error) {
			state.providers = [];
			state.accounts = [];
			state.links = [];
			state.error = messageOf(error, 'Could not load database providers');
			debug.log('db-client', 'provider list unavailable (likely not an admin)');
		} finally {
			state.loaded = true;
			state.loading = false;
		}
	},

	/**
	 * The fire-once entry points.
	 *
	 * These are what an `$effect` calls. They take an id and nothing else, so the
	 * effect subscribes to the id alone — never to the cell the fetch is about to
	 * write, which is what turned the first version into an update-depth loop.
	 * The un-prefixed methods below stay the FORCED path, used by the refresh
	 * controls, and they clear the guard on the way in.
	 */
	ensureLoaded(): void {
		once('providers', () => void this.load());
	},

	ensureRemoteDatabases(accountId: string): void {
		once(`remote:${accountId}`, () => void this.remoteDatabases(accountId));
	},

	ensureContext(connectionId: string, projectId?: string): void {
		once(`context:${connectionId}`, () => void this.loadContext(connectionId, projectId));
	},

	ensureMigrations(connectionId: string, projectId?: string): void {
		once(`migrations:${connectionId}`, () => void this.migrations(connectionId, projectId));
	},

	ensureRls(connectionId: string, projectId?: string): void {
		once(`rls:${connectionId}`, () => void this.rls(connectionId, projectId));
	},

	ensureBuckets(connectionId: string, projectId?: string): void {
		once(`buckets:${connectionId}`, () => void this.buckets(connectionId, projectId));
	},

	ensureAuthUsers(connectionId: string, projectId?: string): void {
		once(`users:${connectionId}`, () =>
			void this.authUsers(connectionId, { limit: 50, offset: 0, projectId })
		);
	},

	ensureFunctions(connectionId: string, projectId?: string): void {
		once(`functions:${connectionId}`, () => void this.functions(connectionId, projectId));
	},

	async remoteDatabases(accountId: string): Promise<DbRemoteDatabase[] | null> {
		requested.add(`remote:${accountId}`);
		return intoCell(
			state.remote,
			accountId,
			() => ws.http('db-client:remote-databases', { accountId }) as Promise<DbRemoteDatabase[]>,
			'Could not list databases for this account'
		);
	},

	/** Organisations and regions for the create form, or null if unsupported. */
	async createOptions(accountId: string): Promise<DbProviderCreateOptions | null> {
		return ws.http('db-client:create-options', { accountId }) as Promise<DbProviderCreateOptions | null>;
	},

	/**
	 * Rename a database at the provider.
	 *
	 * The cached list is patched rather than re-fetched: the new name is the one
	 * thing that changed, and re-reading would put the picker back through a
	 * loading state to learn what we already know.
	 */
	async renameDatabase(accountId: string, remoteRef: string, name: string): Promise<void> {
		await ws.http('db-client:rename-database', { accountId, remoteRef, name });
		const cell = state.remote[accountId];
		if (!cell?.data) return;
		state.remote[accountId] = {
			...cell,
			data: cell.data.map((entry) => (entry.ref === remoteRef ? { ...entry, name } : entry))
		};
	},

	/**
	 * Destroy a database at the provider.
	 *
	 * Not the same as `unlink`, which only removes Clopen's connection. This is
	 * irreversible and the caller is expected to have confirmed it.
	 */
	async deleteDatabase(accountId: string, remoteRef: string): Promise<void> {
		await ws.http('db-client:delete-database', { accountId, remoteRef }, 120_000);
		state.links = state.links.filter(
			(entry) => !(entry.accountId === accountId && entry.remoteRef === remoteRef)
		);
		delete state.remote[accountId];
		forgetKey(`remote:${accountId}`);
	},

	/**
	 * Probe an account whose health has never been checked.
	 *
	 * The status the dialog shows comes from the account row, and nothing writes
	 * it until something probes — so an account connected from here read
	 * "UNKNOWN" forever, which looks like a fault rather than like a question
	 * nobody asked. Reuses the hub's own health route rather than inventing a
	 * second notion of whether a credential works.
	 */
	async probeAccount(accountId: string): Promise<void> {
		once(`probe:${accountId}`, () => {
			void (async () => {
				try {
					// The route names it `id`, not `accountId`.
					const result = await ws.http('integrations:health', { id: accountId }) as {
						status: string;
					};
					state.accounts = state.accounts.map((entry) =>
						entry.accountId === accountId ? { ...entry, status: result.status } : entry
					);
				} catch (error) {
					debug.log('db-client', `Could not probe account ${accountId}: ${messageOf(error, '')}`);
				}
			})();
		});
	},

	/** Forget a probe result so the next check runs again — after a credential change. */
	forgetProbe(accountId: string): void {
		forgetKey(`probe:${accountId}`);
	},

	/** Create the owning organisation, for an account that reaches none. */
	async createGroup(accountId: string, name: string): Promise<{ value: string; label: string }> {
		return ws.http('db-client:create-group', { accountId, name }) as Promise<{
			value: string;
			label: string;
		}>;
	},

	/**
	 * Provision a database and link it.
	 *
	 * Carries a FOUR-MINUTE budget, because the server provisions and then waits
	 * up to three minutes for the database to answer. At the default 30s the
	 * socket would give up while the work carried on, and the user would be told
	 * it failed while a real project quietly finished being created — the exact
	 * shape of the `issues:start-work` timeout. Long, but bounded: an unbounded
	 * call cannot tell "still working" from "this will never answer".
	 */
	async createDatabase(input: {
		accountId: string;
		name: string;
		group: string;
		region: string;
	}): Promise<{ link: DbAccountLinkInfo; ready: boolean }> {
		const result = await ws.http('db-client:create-database', input, 240_000) as {
			link: DbAccountLinkInfo;
			ready: boolean;
		};
		state.links = [...state.links.filter((entry) => entry.id !== result.link.id), result.link];
		delete state.remote[input.accountId];
		forgetKey(`remote:${input.accountId}`);
		return result;
	},

	async link(input: {
		accountId: string;
		remoteRef: string;
		label?: string;
		mode?: string;
		secrets: Record<string, string>;
	}): Promise<DbAccountLinkInfo> {
		const link = await ws.http('db-client:link', input) as DbAccountLinkInfo;
		state.links = [...state.links.filter((entry) => entry.id !== link.id), link];
		// The picker's cached list now has a stale `isLinked`, and re-fetching it
		// is cheaper than patching it correctly. The guard has to be cleared too,
		// or `ensureRemoteDatabases` would consider the question already asked.
		delete state.remote[input.accountId];
		forgetKey(`remote:${input.accountId}`);
		return link;
	},

	async updateLink(
		linkId: string,
		patch: { label?: string; mode?: string; secrets?: Record<string, string>; refreshEndpoint?: boolean }
	): Promise<DbAccountLinkInfo> {
		const link = await ws.http('db-client:update-link', { linkId, ...patch }) as DbAccountLinkInfo;
		state.links = state.links.map((entry) => (entry.id === link.id ? link : entry));
		return link;
	},

	async unlink(linkId: string): Promise<void> {
		await ws.http('db-client:unlink', { linkId });
		const removed = state.links.find((entry) => entry.id === linkId);
		state.links = state.links.filter((entry) => entry.id !== linkId);
		if (removed) {
			delete state.remote[removed.accountId];
			forgetKey(`remote:${removed.accountId}`);
			// The connection is gone, or has just stopped being a Supabase one.
			// Its cached tabs would otherwise be shown to whatever takes its place.
			if (removed.connectionId) this.forget(removed.connectionId);
		}
	},

	// ── Supabase ──────────────────────────────────────────────────────────

	/**
	 * Ask whether a connection is Supabase.
	 *
	 * Called whenever the active connection changes, so it must be cheap and
	 * must not report a failure loudly: a plain Postgres connection answering
	 * "no" is the common case.
	 */
	async loadContext(connectionId: string, projectId?: string): Promise<SupabasePanelContext | null> {
		requested.add(`context:${connectionId}`);
		try {
			const context = await ws.http('db-client:supabase-context', {
				connectionId,
				projectId
			}) as SupabasePanelContext | null;
			state.context[connectionId] = context;
			return context;
		} catch (error) {
			debug.log('db-client', `supabase context unavailable for ${connectionId}: ${messageOf(error, '')}`);
			state.context[connectionId] = null;
			return null;
		}
	},

	migrations(connectionId: string, projectId?: string): Promise<SupabaseMigrationsReport | null> {
		requested.add('migrations:' + connectionId);
		return intoCell(
			state.migrations,
			connectionId,
			() => ws.http('db-client:supabase-migrations', { connectionId, projectId }) as Promise<SupabaseMigrationsReport>,
			'Could not read migrations'
		);
	},

	async migrationSql(connectionId: string, version: string, projectId?: string): Promise<string> {
		const result = await ws.http('db-client:supabase-migration-sql', {
			connectionId,
			version,
			projectId
		}) as { sql: string };
		return result.sql;
	},

	async applyMigration(
		connectionId: string,
		version: string,
		projectId?: string
	): Promise<{ version: string; durationMs: number }> {
		const result = await ws.http('db-client:supabase-apply-migration', {
			connectionId,
			version,
			projectId
		}) as { version: string; durationMs: number };
		await this.migrations(connectionId, projectId);
		return result;
	},

	rls(connectionId: string, projectId?: string): Promise<SupabaseRlsReport | null> {
		requested.add('rls:' + connectionId);
		return intoCell(
			state.rls,
			connectionId,
			() => ws.http('db-client:supabase-rls', { connectionId, projectId }) as Promise<SupabaseRlsReport>,
			'Could not read policies'
		);
	},

	buckets(connectionId: string, projectId?: string): Promise<SupabaseBucket[] | null> {
		requested.add('buckets:' + connectionId);
		return intoCell(
			state.buckets,
			connectionId,
			() => ws.http('db-client:supabase-buckets', { connectionId, projectId }) as Promise<SupabaseBucket[]>,
			'Could not read storage buckets'
		);
	},

	authUsers(
		connectionId: string,
		options: { search?: string; limit?: number; offset?: number; projectId?: string } = {}
	): Promise<SupabaseAuthUsersPage | null> {
		requested.add(`users:${connectionId}`);
		return intoCell(
			state.authUsers,
			connectionId,
			() => ws.http('db-client:supabase-auth-users', { connectionId, ...options }) as Promise<SupabaseAuthUsersPage>,
			'Could not read auth users'
		);
	},

	functions(connectionId: string, projectId?: string): Promise<SupabaseEdgeFunction[] | null> {
		requested.add('functions:' + connectionId);
		return intoCell(
			state.functions,
			connectionId,
			() => ws.http('db-client:supabase-functions', { connectionId, projectId }) as Promise<SupabaseEdgeFunction[]>,
			'Could not list edge functions'
		);
	},

	async functionBody(connectionId: string, slug: string, projectId?: string): Promise<string> {
		const result = await ws.http('db-client:supabase-function-body', {
			connectionId,
			slug,
			projectId
		}) as { body: string };
		return result.body;
	},

	async types(connectionId: string, schemas: string[], projectId?: string): Promise<SupabaseTypesResult> {
		return ws.http('db-client:supabase-types', { connectionId, schemas, projectId }) as Promise<SupabaseTypesResult>;
	},

	async writeTypes(
		connectionId: string,
		path: string,
		contents: string,
		projectId?: string
	): Promise<{ path: string; bytes: number }> {
		return ws.http('db-client:supabase-write-types', {
			connectionId,
			path,
			contents,
			projectId
		}) as Promise<{ path: string; bytes: number }>;
	},

	/** A `supabase start` stack in the current project, if there is one. */
	async detectLocal(projectId?: string): Promise<DetectedLocalStack | null> {
		try {
			state.localStack = await ws.http('db-client:detect-local', { projectId }) as DetectedLocalStack | null;
		} catch {
			state.localStack = null;
		}
		return state.localStack;
	},

	async adoptLocal(projectId?: string): Promise<{ id: string }> {
		const created = await ws.http('db-client:adopt-local', { projectId }) as { id: string };
		state.localStack = state.localStack ? { ...state.localStack, alreadyAdded: true } : null;
		return created;
	},

	/** Drop everything cached for a connection that no longer exists. */
	forget(connectionId: string): void {
		delete state.context[connectionId];
		delete state.migrations[connectionId];
		delete state.rls[connectionId];
		delete state.buckets[connectionId];
		delete state.authUsers[connectionId];
		delete state.functions[connectionId];
		for (const bucket of ['context', 'migrations', 'rls', 'buckets', 'users', 'functions']) {
			forgetKey(`${bucket}:${connectionId}`);
		}
	}
};
