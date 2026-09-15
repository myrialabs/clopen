/**
 * The shapes the Supabase Management API actually returns.
 *
 * Transcribed from the published OpenAPI document, narrowed to the fields this
 * surface reads. Everything optional is optional because the document says so —
 * a field marked required there is still declared optional here when reading it
 * wrong would produce a confident wrong answer rather than a missing one.
 */

export interface SupabaseApiProject {
	id: string;
	ref: string;
	name: string;
	region: string;
	status: string;
	organization_id?: string;
	organization_slug?: string;
	created_at?: string;
	database?: {
		host: string;
		version: string;
		postgres_engine?: string;
		release_channel?: string;
	};
}

/**
 * Supavisor, Supabase's connection pooler.
 *
 * The endpoint answers with an ARRAY — one entry per database, so a project
 * with a read replica has more than one. `connection_string` is treated as a
 * template and never mined for a password: the API cannot hand the password
 * back, so anything password-shaped in there is a placeholder.
 */
export interface SupabaseApiPoolerConfig {
	identifier: string;
	database_type: 'PRIMARY' | 'READ_REPLICA';
	db_user: string;
	db_host: string;
	db_port: number;
	db_name: string;
	connection_string?: string;
	pool_mode?: 'transaction' | 'session';
	default_pool_size?: number | null;
	max_client_conn?: number | null;
	is_using_scram_auth?: boolean;
}

export interface SupabaseApiFunction {
	id: string;
	slug: string;
	name: string;
	status: string;
	version?: number;
	/** Epoch milliseconds, not an ISO string. */
	created_at?: number;
	updated_at?: number;
	verify_jwt?: boolean;
	entrypoint_path?: string;
}

export interface SupabaseApiAdvisorResponse {
	lints?: SupabaseApiLint[];
}

export interface SupabaseApiLint {
	name?: string;
	title?: string;
	level?: string;
	facing?: string;
	description?: string;
	detail?: string;
	remediation?: string;
	categories?: string[];
	metadata?: Record<string, unknown> | null;
	cache_key?: string;
}

export interface SupabaseApiTypes {
	types: string;
}

export interface SupabaseApiMigration {
	version: string;
	name?: string;
}

export interface SupabaseApiOrganization {
	id: string;
	slug: string;
	name: string;
}
