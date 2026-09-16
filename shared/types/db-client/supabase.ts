/**
 * Supabase inside DB Client.
 *
 * The split that shapes every type here: ANYTHING INSIDE THE DATABASE IS READ
 * OVER SQL through the connection DB Client already holds, and only what lives
 * outside it goes to the Management API. Policies, applied migrations, storage
 * buckets and auth users are all ordinary Postgres rows, so they keep working
 * for a `supabase start` stack that has no access token at all. Edge functions,
 * generated types and the security advisor have no SQL equivalent, so they are
 * the ones that go dark without an account, and each says so.
 */

export interface SupabaseMigration {
	version: string;
	name: string | null;
	/** True when the version is recorded in `supabase_migrations.schema_migrations`. */
	isApplied: boolean;
	/** Path of the local file, when the repository has one for this version. */
	path: string | null;
	/** Bytes of SQL in the local file. Null when only the remote knows this version. */
	size: number | null;
}

export interface SupabaseMigrationsReport {
	migrations: SupabaseMigration[];
	/** Absolute path scanned for local migrations, or null when there is no project. */
	localDir: string | null;
	/** True when the remote has versions the working tree does not — someone else pushed. */
	hasRemoteOnly: boolean;
}

export interface SupabasePolicy {
	schema: string;
	table: string;
	name: string;
	/** PERMISSIVE or RESTRICTIVE. */
	permissive: string;
	/** SELECT / INSERT / UPDATE / DELETE / ALL. */
	command: string;
	roles: string[];
	using: string | null;
	withCheck: string | null;
}

export interface SupabaseTableRls {
	schema: string;
	table: string;
	rlsEnabled: boolean;
	policyCount: number;
}

/** One finding from `/advisors/security`. Account-only — there is no SQL for it. */
export interface SupabaseAdvisorLint {
	name: string;
	title: string;
	level: string;
	facing: string;
	description: string;
	detail: string | null;
	remediation: string | null;
	/** Which object the lint is about, when it names one. */
	target: string | null;
}

export interface SupabaseRlsReport {
	tables: SupabaseTableRls[];
	policies: SupabasePolicy[];
	/** Empty when there is no account to ask; `advisorError` then says why. */
	lints: SupabaseAdvisorLint[];
	advisorError: string | null;
}

export interface SupabaseEdgeFunction {
	id: string;
	slug: string;
	name: string;
	status: string;
	version: number | null;
	createdAt: string | null;
	updatedAt: string | null;
	verifyJwt: boolean | null;
	entrypointPath: string | null;
	/** True when this came from the working tree rather than the remote. */
	isLocal: boolean;
}

export interface SupabaseBucket {
	id: string;
	name: string;
	isPublic: boolean;
	fileSizeLimit: number | null;
	allowedMimeTypes: string[] | null;
	objectCount: number | null;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface SupabaseAuthUser {
	id: string;
	email: string | null;
	phone: string | null;
	providers: string[];
	createdAt: string | null;
	lastSignInAt: string | null;
	confirmedAt: string | null;
	isBanned: boolean;
}

export interface SupabaseAuthUsersPage {
	users: SupabaseAuthUser[];
	total: number;
}

/**
 * What the Management API last said about the remaining request budget.
 *
 * Null means "not reported", never "none left" — Supabase only sends these
 * headers on some responses, and a surface that rendered absence as zero would
 * alarm people about a limit they are nowhere near.
 */
export interface SupabaseRateLimitInfo {
	remaining: number;
	limit: number;
	resetAt: string | null;
}

export interface SupabaseTypesResult {
	types: string;
	/** Where it would be written, resolved against the project root. */
	suggestedPath: string;
}
