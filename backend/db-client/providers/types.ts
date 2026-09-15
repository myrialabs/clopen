/**
 * The contract a database provider implements.
 *
 * DB Client is the surface that owns the `database` capability, and unlike
 * Issues and Deployments it owns a TABLE — so a provider here feeds a
 * projection rather than answering reads. The adapter's whole job is to turn
 * "this account, this remote database" into the fields a `db_client_connections`
 * row needs, and to answer the two questions the link dialog asks: what can this
 * credential reach, and is it working.
 *
 * Everything a provider knows about its own service stays inside its directory,
 * the way `Task 3` kept Vercel's per-endpoint API versions inside the Vercel
 * adapter. Turso, Neon and PlanetScale should each be one directory here plus
 * one line in `registry.ts`.
 *
 * NOTE THE SPLIT between resolving an endpoint and projecting a row.
 * `reproject()` is synchronous — it runs inside account mutations — while
 * working out a pooled endpoint's hostname is a network call. So the endpoint is
 * resolved ONCE, when the link is created or refreshed, and stored on the link;
 * the projector then builds the row from stored fields without touching the
 * network. That also means a credential rotation re-projects instantly instead
 * of making every account save wait on a third-party API.
 */

import type {
	DbDriver,
	DbProviderCreateOptions,
	DbProviderInfo,
	DbRemoteDatabase,
	DbSslMode
} from '$shared/types/db-client';
import type { IntegrationStatus } from '$shared/types/integrations';

/** Everything an adapter is given about the account it is acting for. */
export interface DbProviderContext {
	accountId: string;
	/** Decoded account credentials. Empty when the active key could not open them. */
	credentials: Record<string, string>;
}

/**
 * Where a linked database actually answers.
 *
 * Stored on the link as `config.endpoint`, and the only thing the projector
 * reads besides the password. `options` is merged into the connection's options
 * map, which is how the panel later recognises a Supabase-backed connection
 * without db-client having to learn what a provider is.
 */
export interface DbProviderEndpoint {
	host: string;
	port: number;
	username: string;
	database: string;
	sslMode: DbSslMode;
	options?: Record<string, unknown>;
	/**
	 * Secrets the provider resolved for itself, for the providers that can.
	 *
	 * Supabase cannot: its Management API has no endpoint that reads a database
	 * password back, so a link asks the user for one and stores it. Neon can —
	 * `/reveal_password` exists — so it hands one back here and its
	 * `secretFields` is empty, which removes the only manual step in linking a
	 * database.
	 *
	 * `links.ts` PEELS THIS OFF before the endpoint is stored. An endpoint lives
	 * in the link's `config_json`, which is NOT a sealed column; the secrets go
	 * into `secrets`, which is. Leaving the password on the endpoint would write
	 * a working credential to disk in plaintext — the exact thing `Task 1`'s
	 * encryption layer exists to prevent.
	 */
	secrets?: Record<string, string>;
}

/**
 * What this provider's own documentation calls the connection in a dotenv file.
 *
 * Declared rather than derived, because both halves are vendor vocabulary that
 * nothing outside the provider's directory can know: Neon's docs name the pair
 * `DATABASE_URL` / `DATABASE_URL_UNPOOLED`, Supabase's name it `POSTGRES_URL` /
 * `POSTGRES_URL_NON_POOLING`, and which of a provider's connection modes counts
 * as "not behind a pooler" is a fact about its infrastructure.
 *
 * A DEFAULT only. Whatever the project's own files already call the variable
 * wins over this — see `db-client/env/detect.ts`. These names are what a
 * project with nothing in it is offered.
 *
 * The second endpoint is what makes this worth declaring at all. A pooled URL
 * is the right default for an application and the WRONG one for migrations —
 * Prisma's `DIRECT_URL` exists for exactly this — so a connection linked in
 * pooled mode has a counterpart worth writing, and one already on the direct
 * endpoint has none: a `DIRECT_URL` equal to `DATABASE_URL` would look like
 * configuration and change nothing.
 */
export interface DbProviderEnvHints {
	/** What this provider's docs prefix the URL with — `DATABASE`, `POSTGRES`. */
	urlPrefix?: string;
	/** What its docs suffix the second endpoint with — `_UNPOOLED`, `_NON_POOLING`. */
	altKeySuffix?: string;
	/** The mode that is not behind a pooler, when the provider has one. */
	directMode?: string;
	/** Modes that ARE pooled, so a connection on one has a counterpart. */
	pooledModes?: string[];
	/** One sentence naming what the direct endpoint costs, where it costs something. */
	directNotice?: string;
}

export interface DbProviderAdapter {
	/** Matches the integration provider id, so the brand mark is the same one. */
	provider: string;
	driver: DbDriver;
	/** How the link dialog renders this provider. */
	info(): DbProviderInfo;

	/** Every database this credential can reach. */
	listDatabases(context: DbProviderContext): Promise<DbRemoteDatabase[]>;

	/** Resolve where one database answers, in the requested connection mode. */
	resolveEndpoint(
		context: DbProviderContext,
		target: { remoteRef: string; mode: string }
	): Promise<DbProviderEndpoint>;

	/** Health of the credential itself, for the hub's status strip. */
	probe(context: DbProviderContext): Promise<{ status: IntegrationStatus; detail: string | null }>;

	/**
	 * Optional: what this provider's docs call the connection in a dotenv file.
	 *
	 * Absent means DB Client offers its generic presets and no second endpoint,
	 * which is the correct answer for a provider with one endpoint per database.
	 */
	envHints?(): DbProviderEnvHints;

	/**
	 * Optional: create a database rather than only listing existing ones.
	 *
	 * Declared as a pair so the UI can offer it only where it exists. A provider
	 * that cannot create simply omits both, and the dialog shows no such entry
	 * rather than a button that fails.
	 *
	 * `createDatabase` RETURNS THE SECRETS it generated. That is the whole reason
	 * this is worth building: the one awkward step of linking an existing project
	 * is typing a password the API refuses to hand back, and a project WE created
	 * is one whose password we set ourselves — so there is nothing to ask for.
	 * The caller stores them before waiting for the database to come up, because
	 * a password lost while provisioning is a password only a reset can recover.
	 */
	createOptions?(context: DbProviderContext): Promise<DbProviderCreateOptions>;
	createDatabase?(
		context: DbProviderContext,
		input: { name: string; group: string; region: string }
	): Promise<{ ref: string; secrets: Record<string, string> }>;

	/**
	 * Optional: create the owning container too — a Supabase organisation, a
	 * Turso group.
	 *
	 * Offered because the alternative is a dead end that Clopen cannot get the
	 * user out of: an account whose token reaches no organisation cannot create a
	 * database anywhere, and telling someone to go to the vendor's dashboard is
	 * exactly the read-only-window feeling this surface exists to remove. It
	 * stays separate from `createDatabase` because it is a different consequence
	 * — an organisation is a BILLING entity, not a database.
	 */
	createGroup?(
		context: DbProviderContext,
		input: { name: string }
	): Promise<{ value: string; label: string }>;

	/**
	 * Optional: delete a database at the provider.
	 *
	 * Separate from unlinking, and the distinction is the whole point: unlinking
	 * removes Clopen's connection and leaves the database alone, while this
	 * destroys it and everything in it. Only offered where the provider has an
	 * endpoint for it — Supabase can delete a project but has NO endpoint for
	 * deleting an organisation, so that one is absent rather than faked.
	 */
	deleteDatabase?(context: DbProviderContext, remoteRef: string): Promise<void>;

	/**
	 * Optional: rename a database at the provider.
	 *
	 * Renames the DATABASE, not the link — `updateLink` already relabels
	 * Clopen's own copy, and the two are different things: one is what every
	 * collaborator sees in the provider's dashboard, the other is what this
	 * install calls its connection.
	 *
	 * Only offered where the provider has an endpoint. Supabase can rename a
	 * project (`PATCH /v1/projects/{ref}`) but exposes NO update for an
	 * organisation, so that one stays absent rather than faked.
	 */
	renameDatabase?(context: DbProviderContext, remoteRef: string, name: string): Promise<void>;
}
