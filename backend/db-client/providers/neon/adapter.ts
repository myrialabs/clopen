/**
 * Neon as a database provider.
 *
 * Four facts about Neon shape everything below, and all four were checked
 * against the published OpenAPI document rather than assumed:
 *
 *  0. **`/projects` IS ORGANISATION-SCOPED.** The document calls it "a list of
 *     projects for the specified organization", and a personal key that omits
 *     `org_id` is refused with a 400. This was got WRONG first time — the
 *     adapter shipped sending no `org_id` at all, on the reading that a personal
 *     key answers with its user's projects — and every read path failed against
 *     a real key. `GET /users/me/organizations` is the fix and the only endpoint
 *     that answers for both key kinds: given an organisation- or project-scoped
 *     key, which is tied to no user, it returns the organisation that owns it.
 *  1. **The password CAN be read back.** `GET /branches/{id}/roles/{role}/reveal_password`
 *     exists, and `/connection_uri` returns the password inline. So this adapter
 *     declares NO secret fields at all — linking a Neon project asks for
 *     nothing. That is the opposite of Supabase, whose `/database/password` is
 *     PATCH-only by design and forces a link to store one.
 *  2. **A project's organisation arrives with the list.** `ProjectListItem`
 *     carries `org_name`, so naming which organisation will be billed costs no
 *     second request and no extra permission — where Supabase needed both.
 *  3. **Organisations cannot be created through the API.** There is no
 *     `POST /organizations`, so `createGroup` is ABSENT rather than faked —
 *     the rule `Task 4` settled on for the Supabase organisation delete it
 *     could not offer.
 *
 * What DB Client links is a project's DEFAULT BRANCH. Neon has no
 * `default_branch_id` on the project — the flag lives on the branch — so it is
 * resolved at link time and stored on the link, the same split `resolveEndpoint`
 * exists for everywhere else: asking the provider where something answers is a
 * network call, and projecting a row is not.
 */

import type {
	DbProviderAdapter,
	DbProviderContext,
	DbProviderEndpoint,
	DbProviderEnvHints
} from '../types';
import type {
	DbProviderCreateOptions,
	DbProviderInfo,
	DbRemoteDatabase
} from '$shared/types/db-client';
import type { IntegrationStatus } from '$shared/types/integrations';
import type {
	NeonApiCreatedProject,
	NeonApiOrganization,
	NeonApiOrganizationsResponse,
	NeonApiProject,
	NeonApiProjectsResponse,
	NeonApiRegionsResponse
} from './api-types';
import {
	isMissingOrgError,
	isTransportError,
	NEON_SLOW_TIMEOUT_MS,
	NeonError,
	neonRequest,
	type NeonCredentials
} from './client';
import { defaultBranchOf, resolveBranchConnection } from './endpoints';
import { debug } from '$shared/utils/logger';

export const NEON_PROVIDER_ID = 'neon';

/** Connection modes, in the order the dialog offers them. */
export const NEON_MODES = {
	direct: 'direct',
	pooled: 'pooled'
} as const;

export function neonCredentialsOf(context: DbProviderContext): NeonCredentials {
	const apiKey = (context.credentials.apiKey ?? '').trim();
	if (!apiKey) {
		throw new NeonError(
			'This Neon account has no API key. Reconnect it in Settings → Integrations.',
			401,
			'auth'
		);
	}
	return { apiKey };
}

/**
 * Organisations this key can act in.
 *
 * `GET /users/me/organizations` is the ONE endpoint that answers for both kinds
 * of Neon key, and the document is explicit about why: called with an
 * organisation- or project-scoped key, which is not tied to a user at all, it
 * returns the single organisation that owns the key. Everything else that
 * identifies a key is user-shaped and 4xxs for the scoped ones.
 *
 * Memoised briefly per key. `listNeonProjects` sits on the readiness poll's
 * path, which runs every five seconds for up to three minutes, and without this
 * each tick would cost two requests instead of one for an answer that cannot
 * change without a visit to Neon's console. A minute bounds the staleness for
 * the one case that does change it — being added to an organisation elsewhere.
 */
const ORGANIZATION_TTL_MS = 60_000;
const organizationCache = new Map<string, { at: number; organizations: NeonApiOrganization[] }>();

export async function listNeonOrganizations(
	credentials: NeonCredentials
): Promise<NeonApiOrganization[]> {
	const cached = organizationCache.get(credentials.apiKey);
	if (cached && Date.now() - cached.at < ORGANIZATION_TTL_MS) return cached.organizations;

	const response = await neonRequest<NeonApiOrganizationsResponse>(
		credentials,
		'/users/me/organizations'
	);
	const organizations = (response?.organizations ?? []).filter((entry) => entry?.id);
	organizationCache.set(credentials.apiKey, { at: Date.now(), organizations });
	return organizations;
}

async function projectsOf(
	credentials: NeonCredentials,
	orgId: string | undefined
): Promise<NeonApiProject[]> {
	const response = await neonRequest<NeonApiProjectsResponse>(credentials, '/projects', {
		query: { limit: 400, org_id: orgId }
	});
	// A soft-deleted project sits in a recovery window and still appears. It
	// cannot be connected to, and offering it would be offering a dead end.
	return (response?.projects ?? []).filter((project) => !project.deleted_at);
}

/**
 * Every project this key can reach, asked for ONE ORGANISATION AT A TIME.
 *
 * `/projects` is organisation-scoped — the document calls it "a list of projects
 * for the specified organization" — and a personal key that omits `org_id` is
 * refused outright with "org_id is required, you can find it on your
 * organization settings page". A bare call is therefore not the general case;
 * it is the legacy fallback for an account that reports no organisation at all.
 *
 * Fanning out over every organisation also fixes a quieter bug than the 400: a
 * key belonging to two organisations would only ever have seen one of them.
 *
 * A partial failure is TOLERATED but never silent. Dropping one organisation's
 * projects and rendering the rest as the whole list is the "an absent signal is
 * not a negative one" mistake `Task 3` recorded twice; so the failures are
 * logged, and when nothing at all came back the first error is rethrown rather
 * than answering with an empty list the caller would read as "no projects".
 */
export async function listNeonProjects(credentials: NeonCredentials): Promise<NeonApiProject[]> {
	const organizations = await listNeonOrganizations(credentials);
	const scopes: (string | undefined)[] =
		organizations.length > 0 ? organizations.map((entry) => entry.id) : [undefined];

	const failures: unknown[] = [];
	const collected = new Map<string, NeonApiProject>();

	const pages = await Promise.all(
		scopes.map(async (orgId) => {
			try {
				return await projectsOf(credentials, orgId);
			} catch (error) {
				failures.push(error);
				debug.warn('db-client', `Could not list Neon projects for org ${orgId ?? '(none)'}:`, error);
				return [] as NeonApiProject[];
			}
		})
	);

	for (const page of pages) {
		for (const project of page) collected.set(project.id, project);
	}

	if (collected.size === 0 && failures.length > 0) {
		// Rewritten rather than repeated. Neon's own wording — "org_id is required,
		// you can find it on your organization settings page" — describes a call
		// the user cannot make and sends them to a page that cannot help, because
		// by here it is OUR organisation lookup that came back empty. The same
		// trick `Task 2` used on GitHub's 404 and `Task 4` on Supabase's 403: the
		// provider's word for it is undiagnosable, so name the real cause.
		if (isMissingOrgError(failures[0]) && organizations.length === 0) {
			throw new NeonError(
				'This API key reaches no Neon organisation — create the key again from the account that owns your projects.',
				400,
				'config'
			);
		}
		throw failures[0];
	}
	return [...collected.values()];
}

function detailOf(project: NeonApiProject): string {
	const parts = [project.region_id];
	if (project.pg_version) parts.push(`Postgres ${project.pg_version}`);
	return parts.filter(Boolean).join(' · ');
}


function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** How far back a project can have been created and still be the one we asked for. */
const RECONCILE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Find the project a dropped `POST /projects` may still have created.
 *
 * Matching is by NAME within a recent window, and the newest match wins. Neon
 * allows duplicate project names, so this can in principle pick a project the
 * user created themselves moments earlier — but the alternatives are worse in
 * both directions: retrying the POST provisions and bills for a second real
 * database, and reporting a failure abandons one that exists.
 *
 * The list itself is retried once by the client, since a GET is safe to repeat.
 * Coming back empty means the create genuinely did not land, and that is
 * reported as itself rather than as the socket error the user cannot act on.
 */
async function findJustCreatedProject(
	credentials: NeonCredentials,
	input: { name: string; group: string },
	cause: unknown
): Promise<string> {
	let projects: NeonApiProject[];
	try {
		projects = await listNeonProjects(credentials);
	} catch {
		throw new NeonError(
			`${messageOf(cause)} Check the Neon console before trying again, in case the project was created.`,
			0,
			'error'
		);
	}

	const cutoff = Date.now() - RECONCILE_WINDOW_MS;
	const match = projects
		.filter((project) => (project.name ?? '') === input.name)
		.filter((project) => !input.group || project.org_id === input.group)
		.filter((project) => {
			const at = project.created_at ? Date.parse(project.created_at) : NaN;
			return !Number.isFinite(at) || at >= cutoff;
		})
		.sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0];

	if (!match) {
		throw new NeonError(
			`${messageOf(cause)} Nothing was created, so try again.`,
			0,
			'error'
		);
	}

	debug.log('db-client', `Reconciled the dropped Neon create onto project ${match.id}`);
	return match.id;
}

export const neonDbAdapter: DbProviderAdapter = {
	provider: NEON_PROVIDER_ID,
	driver: 'postgres',

	info(): DbProviderInfo {
		return {
			id: NEON_PROVIDER_ID,
			name: 'Neon',
			driver: 'postgres',
			description: "Pick a Neon project. Its default branch becomes the connection — nothing to type, Neon hands the password back.",
			// Direct is the silent default and pooled is the escape hatch, which is
			// the reverse of Supabase and for a concrete reason: Neon's pooled
			// endpoint runs PgBouncer in TRANSACTION mode, which breaks the prepared
			// statements `Bun.sql` uses. Neon's direct host is reachable over IPv4,
			// so the trade Supabase faced — pooler or unreachable — does not arise.
			modes: [
				{
					id: NEON_MODES.direct,
					label: 'Direct',
					help: 'The right choice for this client.',
					isDefault: true
				},
				{
					id: NEON_MODES.pooled,
					label: 'Pooled',
					help: 'Transaction mode, which breaks prepared statements.',
					isAdvanced: true
				}
			],
			// EMPTY, and that is the feature. Neon can reveal a role's password, so
			// there is nothing for the user to fetch from a dashboard and paste.
			secretFields: []
		};
	},

	/**
	 * Neon's own snippet names the pair `DATABASE_URL` and
	 * `DATABASE_URL_UNPOOLED`, so that is the preset, and the unpooled half is
	 * the DIRECT endpoint — the one a migration has to run on, because Neon's
	 * pooler is PgBouncer in transaction mode.
	 */
	envHints(): DbProviderEnvHints {
		return {
			urlPrefix: 'DATABASE',
			altKeySuffix: '_UNPOOLED',
			directMode: NEON_MODES.direct,
			pooledModes: [NEON_MODES.pooled]
		};
	},

	async listDatabases(context: DbProviderContext): Promise<DbRemoteDatabase[]> {
		const credentials = neonCredentialsOf(context);
		const [projects, organizations] = await Promise.all([
			listNeonProjects(credentials),
			// Already memoised, and already fetched by `listNeonProjects` itself —
			// so naming the owner costs nothing.
			listNeonOrganizations(credentials).catch(() => [] as NeonApiOrganization[])
		]);
		const names = new Map(organizations.map((entry) => [entry.id, entry.name || entry.handle || entry.id]));

		return projects.map((project) => ({
			ref: project.id,
			name: project.name || project.id,
			detail: detailOf(project),
			// The NAME of the organisation, or nothing. An earlier version fell back
			// to the literal word "Organisation", which rendered on every row and
			// made two projects in different organisations indistinguishable — the
			// exact question this field exists to answer.
			group: project.org_name ?? (project.org_id ? names.get(project.org_id) ?? null : null),
			status: null,
			// A Neon project has no state of its own — its branches do, and a
			// suspended compute wakes on connection. So every listed project is
			// connectable, and claiming otherwise would disable rows that work.
			isReady: true,
			isLinked: false
		}));
	},

	async resolveEndpoint(
		context: DbProviderContext,
		target: { remoteRef: string; mode: string }
	): Promise<DbProviderEndpoint> {
		const credentials = neonCredentialsOf(context);
		const branch = await defaultBranchOf(credentials, target.remoteRef);
		const connection = await resolveBranchConnection(credentials, {
			projectId: target.remoteRef,
			branchId: branch.id,
			pooled: target.mode === NEON_MODES.pooled
		});

		return {
			host: connection.host,
			port: connection.port,
			username: connection.username,
			database: connection.database,
			sslMode: connection.sslMode,
			options: {
				neon: {
					projectId: target.remoteRef,
					branchId: branch.id,
					mode: target.mode
				}
			},
			/**
			 * The password, resolved rather than asked for.
			 *
			 * This is the whole reason `secretFields` is empty: Neon reveals a
			 * role's password, so the one awkward step of linking a managed Postgres
			 * — finding a password in a dashboard and pasting it — does not exist
			 * here. `links.ts` PEELS this off before storing the endpoint, because
			 * an endpoint lives in `config_json` and that column is not sealed.
			 */
			secrets: { password: connection.password }
		};
	},

	async createOptions(context: DbProviderContext): Promise<DbProviderCreateOptions> {
		const credentials = neonCredentialsOf(context);

		// The SAME organisation read every other call here makes, so the answer is
		// already memoised and the two views cannot disagree about what this key
		// can reach. Both are tolerated failing: a form that refuses to render
		// because the region list timed out removes a capability that works.
		const [organizations, regions] = await Promise.all([
			listNeonOrganizations(credentials).catch((error) => {
				debug.warn('db-client', 'Could not list Neon organizations:', error);
				return [] as NeonApiOrganization[];
			}),
			neonRequest<NeonApiRegionsResponse>(credentials, '/regions').catch((error) => {
				debug.warn('db-client', 'Could not list Neon regions:', error);
				return null;
			})
		]);

		const groups = organizations.map((organization) => ({
			value: organization.id,
			label: organization.name || organization.handle || organization.id,
			detail: organization.plan ?? null
		}));

		// NO synthetic "personal account" entry. An earlier version offered one
		// with an empty `org_id`, on the reading that a personal key creates
		// projects under its user — but `/projects` is organisation-scoped, and a
		// project created without an owner is one this adapter then cannot list.
		// Neon reports a personal account as an organisation of its own, so the
		// real entry is always in the list above when there is one at all.
		//
		// The empty case is left empty on purpose rather than back-filled with a
		// placeholder: `emptyGroupsNotice` is shown instead of the form, which is
		// the honest outcome for a key that can reach nowhere to create anything.

		// Live, not hard-coded. `GET /regions` is a documented, non-beta endpoint
		// that needs no organisation — the three things that forced `Task 4` to
		// hard-code Supabase's list are all absent here.
		const regionList = (regions?.regions ?? [])
			.filter((region) => region?.region_id)
			.map((region) => ({ value: region.region_id, label: region.name || region.region_id }));

		return {
			groupLabel: 'Organisation',
			groups,
			regionLabel: 'Region',
			regions: regionList.length > 0
				? regionList
				: [{ value: 'aws-us-east-2', label: 'AWS US East (Ohio)' }],
			notice:
				"This provisions a real Postgres project on Neon. It counts against the owner's project quota and its plan decides what it costs.",
			// Reachable, and one sentence with one instruction: a key that reports
			// no organisation cannot create a project anywhere, and the only fix is
			// a different key.
			emptyGroupsNotice:
				'This API key reaches no organisation — create the key again from the Neon account that owns your projects.',
			canCreateGroup: false,
			createGroupNotice: '',
			// Neon has no organisation endpoints at all — no POST, no PATCH, no
			// DELETE — so all three buttons are absent rather than faked, and this
			// says so once instead of leaving three holes to interpret.
			groupManagementNotice: "Organisations are created and managed in Neon's console."
		};
	},

	async createDatabase(
		context: DbProviderContext,
		input: { name: string; group: string; region: string }
	): Promise<{ ref: string; secrets: Record<string, string> }> {
		const credentials = neonCredentialsOf(context);

		let created: NeonApiCreatedProject | null;
		try {
			created = await neonRequest<NeonApiCreatedProject>(credentials, '/projects', {
				method: 'POST',
				body: {
					project: {
						name: input.name,
						region_id: input.region,
						// Sending an empty string would ask Neon to create the project
						// inside an organisation called "". The form no longer offers a
						// blank owner, so this guard is the backstop rather than the path.
						...(input.group ? { org_id: input.group } : {})
					}
				},
				timeoutMs: NEON_SLOW_TIMEOUT_MS
			});
		} catch (error) {
			// A DROPPED CONNECTION is not a failed create. Provisioning takes long
			// enough that the socket closes while Neon is still working, and the
			// project appears anyway — so retrying the POST would bill for a second
			// one, and reporting a failure would leave a real database nobody
			// linked. Ask what actually exists instead.
			if (!isTransportError(error)) throw error;
			debug.warn('db-client', `Neon create dropped the connection, reconciling: ${messageOf(error)}`);
			return { ref: await findJustCreatedProject(credentials, input, error), secrets: {} };
		}

		const ref = created?.project?.id;
		if (!ref) {
			throw new NeonError(
				'Neon accepted the project but did not report its id, so it cannot be linked automatically. It will be in the list once it finishes provisioning.',
				502,
				'error'
			);
		}
		// No secret to carry. Neon reveals the password on demand, so a link holds
		// nothing and `resolveEndpoint` fetches it — which also means a password
		// reset at Neon is picked up by re-resolving rather than by re-typing.
		return { ref, secrets: {} };
	},

	async deleteDatabase(context: DbProviderContext, remoteRef: string): Promise<void> {
		await neonRequest(
			neonCredentialsOf(context),
			`/projects/${encodeURIComponent(remoteRef)}`,
			{ method: 'DELETE', timeoutMs: NEON_SLOW_TIMEOUT_MS }
		);
	},

	async renameDatabase(context: DbProviderContext, remoteRef: string, name: string): Promise<void> {
		await neonRequest(
			neonCredentialsOf(context),
			`/projects/${encodeURIComponent(remoteRef)}`,
			{ method: 'PATCH', body: { project: { name } } }
		);
	},

	async probe(context: DbProviderContext): Promise<{ status: IntegrationStatus; detail: string | null }> {
		try {
			const projects = await listNeonProjects(neonCredentialsOf(context));
			if (projects.length === 0) {
				return {
					status: 'needs_config',
					detail: 'The key works but reaches no projects — check which Neon account or organisation it belongs to.'
				};
			}
			const plural = projects.length === 1 ? 'project' : 'projects';
			return { status: 'ok', detail: `${projects.length} ${plural} reachable` };
		} catch (error) {
			if (error instanceof NeonError) {
				const status: IntegrationStatus = error.kind === 'auth'
					? 'needs_auth'
					: error.kind === 'config' || error.kind === 'quota' ? 'needs_config' : 'error';
				return { status, detail: error.message };
			}
			return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
		}
	}
};
