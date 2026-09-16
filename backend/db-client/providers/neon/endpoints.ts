/**
 * Working out where a Neon branch answers.
 *
 * Shared by both surfaces Neon serves: DB Client resolves the DEFAULT branch of
 * a linked project, and the worktree manager resolves the branch it just cut.
 * Same question, same three facts about how Neon answers it, so it lives in one
 * place rather than being solved twice with two sets of bugs.
 *
 * The three facts:
 *
 *  1. THERE ARE TWO DIFFERENT CONNECTION SHAPES, and confusing them is what
 *     shipped first. `GET /connection_uri` answers with `ConnectionURIResponse`
 *     — `{ uri }`, one bare string and nothing else. The `connection_uris[]`
 *     array on a CREATE response is `ConnectionDetails` — `{ connection_uri,
 *     connection_parameters }`, with the host, role, database and password as
 *     discrete fields. Reading the first as though it were the second leaves
 *     every field undefined, which is exactly how linking a project failed with
 *     "Neon did not report a host".
 *  2. `GET /connection_uri` REQUIRES `database_name` and `role_name`. There is
 *     no "give me the obvious one" form, so both have to be discovered first.
 *  3. A create response often — but NOT always — carries `connection_uris`
 *     already, complete with the password and both hosts. Using it when it is
 *     there turns three requests into zero; requiring it would break on any
 *     project with more than one role or database.
 *  4. `connection_parameters` carries `host` AND `pooler_host` together, so
 *     pooled versus direct is a choice of which field to read rather than a
 *     second round trip. The bare `{ uri }` form carries only ONE host — the one
 *     the `pooled` query parameter asked for — so it is authoritative for the
 *     mode it was requested in and useless for the other.
 */

import type { BranchConnection } from '$shared/types/worktree-branching';
import {
	neonRequest,
	NeonError,
	type NeonCredentials
} from './client';
import type {
	NeonApiBranch,
	NeonApiBranchesResponse,
	NeonApiConnectionUri,
	NeonApiConnectionUriResponse,
	NeonApiDatabase,
	NeonApiRole,
	NeonApiRolePassword
} from './api-types';

/** Neon answers on 5432 for both the direct host and the pooled one. */
export const NEON_PORT = 5432;

/**
 * `require`, not `verify-full`.
 *
 * Neon's certificates come from a public CA, so verification could work — but
 * it depends on the root store the process happens to have, and a TLS failure
 * here surfaces as an unexplained connection refusal rather than as a
 * certificate problem. `require` is the honest setting for a client that does
 * not ship its own trust store: encrypted, not pinned.
 */
export const NEON_SSL_MODE = 'require' as const;

export async function listBranches(
	credentials: NeonCredentials,
	projectId: string
): Promise<NeonApiBranch[]> {
	const response = await neonRequest<NeonApiBranchesResponse>(
		credentials,
		`/projects/${encodeURIComponent(projectId)}/branches`
	);
	return response?.branches ?? [];
}

/**
 * The branch new branches are cut from, and the one DB Client links.
 *
 * Neon has no `default_branch_id` on a project — the flag lives on the branch —
 * so this is a list plus a find rather than a read. Falling back to the first
 * branch is deliberate: a project always has at least one, and refusing to act
 * because no row carried the flag would be a failure invented by the client.
 */
export async function defaultBranchOf(
	credentials: NeonCredentials,
	projectId: string
): Promise<NeonApiBranch> {
	const branches = await listBranches(credentials, projectId);
	const preferred = branches.find((branch) => branch.default === true) ?? branches[0];
	if (!preferred) {
		throw new NeonError(
			`Neon reports no branches for project ${projectId}, so there is nothing to connect to.`,
			404,
			'config'
		);
	}
	return preferred;
}

/**
 * A role to connect as.
 *
 * PROTECTED roles are skipped. Neon marks its system roles protected, and they
 * are not the owner a migration needs — connecting as one produces permission
 * errors deep inside someone's migration rather than at connection time.
 */
function pickRole(roles: NeonApiRole[]): NeonApiRole | null {
	return roles.find((role) => role.protected !== true && role.name) ?? roles.find((role) => role.name) ?? null;
}

function pickDatabase(databases: NeonApiDatabase[]): NeonApiDatabase | null {
	return databases.find((database) => database.name) ?? null;
}

/** Turn a connection-URI payload into the shape both surfaces store. */
function fromConnectionUri(entry: NeonApiConnectionUri, pooled: boolean): BranchConnection | null {
	const parameters = entry.connection_parameters;
	if (!parameters?.host || !parameters.role || !parameters.database) return null;
	if (!parameters.password) return null;

	const host = pooled ? (parameters.pooler_host || parameters.host) : parameters.host;

	// The URI is REBUILT from the parts rather than taken verbatim, for one
	// reason: `connection_uri` always names the direct host, so a pooled request
	// answered with a URI that contradicts the parameters beside it. Building it
	// here keeps the string and the fields describing the same endpoint.
	return {
		uri: buildUri({
			host,
			username: parameters.role,
			password: parameters.password,
			database: parameters.database
		}),
		host,
		port: NEON_PORT,
		username: parameters.role,
		password: parameters.password,
		database: parameters.database,
		sslMode: NEON_SSL_MODE
	};
}

/**
 * Read a libpq URI back into its parts.
 *
 * This is what `GET /connection_uri` needs, because that endpoint answers with
 * the string and nothing else. The URI is kept VERBATIM rather than rebuilt:
 * it is Neon's own, it already reflects the `pooled` parameter it was asked
 * for, and it may carry options (`channel_binding`) that rebuilding would drop.
 * The discrete fields are derived from the same string, so the two cannot
 * disagree.
 */
export function parseConnectionUri(uri: string): BranchConnection | null {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}

	const host = url.hostname;
	const username = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
	// A URI without a password cannot log in, and reporting it as resolved would
	// push the failure into a driver that says "authentication failed" instead.
	if (!host || !username || !password || !database) return null;

	return {
		uri,
		host,
		port: url.port ? Number(url.port) : NEON_PORT,
		username,
		password,
		database,
		sslMode: NEON_SSL_MODE
	};
}

/** A libpq connection URI, with every component escaped. */
export function buildUri(input: {
	host: string;
	username: string;
	password: string;
	database: string;
}): string {
	const user = encodeURIComponent(input.username);
	const password = encodeURIComponent(input.password);
	const database = encodeURIComponent(input.database);
	return `postgresql://${user}:${password}@${input.host}/${database}?sslmode=${NEON_SSL_MODE}`;
}

/**
 * Read a connection out of a create response, when it carried one.
 *
 * Returns null rather than throwing when it did not — the caller then resolves
 * the long way. See `api-types.ts`: this field is documented as absent for any
 * branch cut from a parent with more than one role or database.
 */
export function connectionFromCreateResponse(
	entries: NeonApiConnectionUri[] | undefined,
	pooled: boolean
): BranchConnection | null {
	for (const entry of entries ?? []) {
		const fromParameters = fromConnectionUri(entry, pooled);
		if (fromParameters) return fromParameters;

		// No `connection_parameters`, so only the string is available — and it
		// names the DIRECT host. That is the answer for a direct request and the
		// wrong one for a pooled request, where deriving the pooler hostname
		// would mean guessing at a naming convention. Returning null there sends
		// the caller to `GET /connection_uri?pooled=true`, which answers
		// authoritatively.
		if (!pooled && entry.connection_uri) {
			const parsed = parseConnectionUri(entry.connection_uri);
			if (parsed) return parsed;
		}
	}
	return null;
}

/**
 * Resolve where a branch answers, asking Neon for whatever is still unknown.
 *
 * Three requests in the worst case, and they are not avoidable: the endpoint
 * that hands back a connection URI insists on being told which database and
 * which role, and neither is derivable from the branch id.
 */
export async function resolveBranchConnection(
	credentials: NeonCredentials,
	input: { projectId: string; branchId: string; pooled: boolean }
): Promise<BranchConnection> {
	const base = `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`;

	const [databases, roles] = await Promise.all([
		neonRequest<{ databases?: NeonApiDatabase[] }>(credentials, `${base}/databases`),
		neonRequest<{ roles?: NeonApiRole[] }>(credentials, `${base}/roles`)
	]);

	const database = pickDatabase(databases?.databases ?? []);
	const role = pickRole(roles?.roles ?? []);

	if (!database?.name || !role?.name) {
		throw new NeonError(
			'This Neon branch has no database and role to connect as, so no connection string can be built for it.',
			404,
			'config'
		);
	}

	// `{ uri }` and NOTHING else — see fact 1 in the header. The answer already
	// reflects `pooled`, so parsing it is both simpler and more faithful than
	// assembling one from parts we would have to fetch separately.
	const response = await neonRequest<NeonApiConnectionUriResponse>(
		credentials,
		`/projects/${encodeURIComponent(input.projectId)}/connection_uri`,
		{
			query: {
				branch_id: input.branchId,
				database_name: database.name,
				role_name: role.name,
				pooled: input.pooled
			}
		}
	);

	const resolved = response?.uri ? parseConnectionUri(response.uri) : null;
	if (resolved) return resolved;

	// The URI was missing or carried no password. Neon stores role passwords
	// unless a project opted out, so the role itself is the one remaining source
	// — and it is a source no other managed Postgres in this codebase has.
	const host = response?.uri ? safeHost(response.uri) : null;
	if (!host) {
		throw new NeonError(
			`Neon returned no usable connection string for branch ${input.branchId}. Check the branch has a compute endpoint in the Neon console.`,
			502,
			'error'
		);
	}

	const revealed = await neonRequest<NeonApiRolePassword>(
		credentials,
		`${base}/roles/${encodeURIComponent(role.name)}/reveal_password`
	);
	if (!revealed?.password) {
		throw new NeonError(
			`Neon would not reveal the password for role "${role.name}". Create the project again with password storage enabled, or connect it by hand.`,
			403,
			'config'
		);
	}

	return {
		uri: buildUri({
			host,
			username: role.name,
			password: revealed.password,
			database: database.name
		}),
		host,
		port: NEON_PORT,
		username: role.name,
		password: revealed.password,
		database: database.name,
		sslMode: NEON_SSL_MODE
	};
}

/** The hostname of a URI, or null when it is not one. */
function safeHost(uri: string): string | null {
	try {
		return new URL(uri).hostname || null;
	} catch {
		return null;
	}
}
