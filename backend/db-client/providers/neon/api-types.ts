/**
 * The parts of Neon's API shapes this codebase reads.
 *
 * Transcribed from the published OpenAPI document, and deliberately NOT
 * complete: a `Branch` there carries thirty fields, most of them billing
 * counters. Only what is actually read is declared, so a field appearing here
 * is evidence something depends on it.
 *
 * Everything optional is optional HERE even when the document marks it
 * required, with two exceptions kept required because nothing can proceed
 * without them (`id` on a project, `id`/`name` on a branch). A response that
 * omits a "required" field is a real possibility across API versions, and a
 * type that promises otherwise turns it into a `TypeError` inside a list
 * render rather than a handled absence.
 */

/** `GET /projects` → `{ projects: [...] }`, and `GET /projects/{id}` → `{ project }`. */
export interface NeonApiProject {
	id: string;
	name?: string;
	region_id?: string;
	pg_version?: number;
	/** Present on projects owned by an organisation rather than by a user. */
	org_id?: string;
	/**
	 * The organisation's display name, carried on the LIST ITEM itself.
	 *
	 * Worth noting because it makes Neon cheaper to list than Supabase: there,
	 * naming the organisation of each project needs a second endpoint and a
	 * permission the token may not have. Here it arrives with the list.
	 */
	org_name?: string;
	created_at?: string;
	/** False when the project was created with password storage disabled. */
	store_passwords?: boolean;
	/** Set on a soft-deleted project inside its recovery window. */
	deleted_at?: string | null;
}

export interface NeonApiProjectsResponse {
	projects?: NeonApiProject[];
}

export interface NeonApiProjectResponse {
	project?: NeonApiProject;
}

/**
 * `current_state` is a free-form string in the document, not an enum, so it is
 * typed as one. `ready` is the only value that means connectable — `init` and
 * `resetting` refuse queries, and `archived` answers them very slowly.
 */
export interface NeonApiBranch {
	id: string;
	name: string;
	project_id?: string;
	parent_id?: string;
	current_state?: string;
	/** The project's default branch. Never ours, and never offered for deletion. */
	default?: boolean;
	/** A protected branch cannot be deleted, which is worth saying before trying. */
	protected?: boolean;
	logical_size?: number;
	created_at?: string;
}

export interface NeonApiBranchesResponse {
	branches?: NeonApiBranch[];
}

/** The discrete half of a connection URI, which is what the projector needs. */
export interface NeonApiConnectionParameters {
	database?: string;
	password?: string;
	role?: string;
	host?: string;
	/**
	 * The pooled host, carried ALONGSIDE the direct one.
	 *
	 * This is why asking for a pooled endpoint costs no extra request: both
	 * hosts arrive together, so the mode is a choice about which field to read
	 * rather than a second round trip.
	 */
	pooler_host?: string;
}

/**
 * One entry of a `connection_uris[]` array — Neon's `ConnectionDetails`.
 *
 * NOT what `GET /connection_uri` answers with. That endpoint returns
 * `NeonApiConnectionUriResponse` below, a bare `{ uri }`, and reading one as
 * the other leaves every discrete field undefined — which is how linking a
 * project failed with "Neon did not report a host". The two are declared
 * separately here so the next reader cannot repeat it.
 */
export interface NeonApiConnectionUri {
	connection_uri?: string;
	connection_parameters?: NeonApiConnectionParameters;
}

/**
 * What `GET /projects/{id}/connection_uri` answers with — `ConnectionURIResponse`.
 *
 * One string. The document marks `uri` as the only property and the only
 * required one, so there is no host, role or database field to read: the parts
 * come from parsing it.
 */
export interface NeonApiConnectionUriResponse {
	uri?: string;
}

/**
 * What `POST /projects/{id}/branches` answers with.
 *
 * `connection_uris` IS OPTIONAL, and that is the single most important fact in
 * this file. The document states it plainly: a branch cut from a parent with
 * more than one role or database comes back without one. Treating it as
 * guaranteed would work on every simple project and fail on exactly the
 * established ones this feature is most useful for.
 */
export interface NeonApiCreatedBranch {
	branch?: NeonApiBranch;
	endpoints?: NeonApiEndpoint[];
	roles?: NeonApiRole[];
	databases?: NeonApiDatabase[];
	connection_uris?: NeonApiConnectionUri[];
}

export interface NeonApiEndpoint {
	id?: string;
	host?: string;
	branch_id?: string;
	type?: string;
	current_state?: string;
}

export interface NeonApiRole {
	name?: string;
	branch_id?: string;
	/** Only present when the project stores passwords; read back separately if not. */
	password?: string;
	protected?: boolean;
}

export interface NeonApiDatabase {
	name?: string;
	branch_id?: string;
	owner_name?: string;
}

export interface NeonApiRolePassword {
	password?: string;
}

export interface NeonApiOrganization {
	id: string;
	name?: string;
	handle?: string;
	plan?: string;
}

export interface NeonApiOrganizationsResponse {
	organizations?: NeonApiOrganization[];
}

export interface NeonApiRegion {
	region_id: string;
	name?: string;
	default?: boolean;
}

export interface NeonApiRegionsResponse {
	regions?: NeonApiRegion[];
}

/** `POST /projects` answers with the project plus its first connection URI. */
export interface NeonApiCreatedProject {
	project?: NeonApiProject;
	connection_uris?: NeonApiConnectionUri[];
	roles?: NeonApiRole[];
	databases?: NeonApiDatabase[];
}
