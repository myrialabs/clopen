/**
 * Supabase as a database provider.
 *
 * Three facts about Supabase shape everything below, and all three were checked
 * against the published API document rather than assumed:
 *
 *  1. **The password cannot be read back.** There is no GET for a project's
 *     database password — only a PATCH that changes it. So a link asks for it
 *     once and stores it, and `resolveEndpoint` never pretends to know it.
 *  2. **Direct connections are IPv6-only on projects created since 2024**,
 *     unless the account pays for an IPv4 add-on. A default of "direct" would
 *     therefore fail on most new projects with a DNS-shaped error that says
 *     nothing about the cause, so the pooler is the default and direct is an
 *     explicit choice that says why it might not work.
 *  3. **Transaction mode does not support prepared statements.** Our Postgres
 *     driver is `Bun.sql`, which prepares, so transaction mode (port 6543) is
 *     offered but is not the default and says what it costs. Session mode on the
 *     pooler host is the one combination that is both reachable and compatible.
 *
 * The pooler host is NOT derivable from the project ref — it encodes the
 * region — so it is fetched from `/config/database/pooler` at link time and
 * stored on the link.
 */

import type {
	DbProviderAdapter,
	DbProviderContext,
	DbProviderEndpoint
} from '../types';
import type {
	DbProviderCreateGroup,
	DbProviderCreateOptions,
	DbProviderInfo,
	DbRemoteDatabase
} from '$shared/types/db-client';
import type { IntegrationStatus } from '$shared/types/integrations';
import type { SupabaseApiOrganization, SupabaseApiPoolerConfig, SupabaseApiProject } from './api-types';
import { SUPABASE_SLOW_TIMEOUT_MS, SupabaseError, supabaseRequest, type SupabaseCredentials } from './client';
import { debug } from '$shared/utils/logger';

export const SUPABASE_PROVIDER_ID = 'supabase';

/** Connection modes, in the order the dialog offers them. */
export const SUPABASE_MODES = {
	poolerSession: 'pooler-session',
	poolerTransaction: 'pooler-transaction',
	direct: 'direct'
} as const;

/** Supavisor listens for session mode on 5432 and transaction mode on 6543. */
const POOLER_SESSION_PORT = 5432;
const POOLER_TRANSACTION_PORT = 6543;
const DIRECT_PORT = 5432;

export function supabaseCredentialsOf(context: DbProviderContext): SupabaseCredentials {
	const accessToken = (context.credentials.accessToken ?? '').trim();
	if (!accessToken) {
		throw new SupabaseError(
			'This Supabase account has no access token. Reconnect it in Settings → Integrations.',
			401,
			'auth'
		);
	}
	return { accessToken };
}

/**
 * The one state a project can actually be connected to in.
 *
 * Everything else — `COMING_UP`, `PAUSED`, `RESTORING` — looks like an ordinary
 * row in a list and refuses every connection, which is why readiness is
 * reported rather than inferred from the row existing.
 */
const READY_STATUS = 'ACTIVE_HEALTHY';

/**
 * Regions, taken from the `region` enum in the published API document.
 *
 * Hard-coded deliberately. The live source is `GET /v1/projects/available-regions`,
 * which is marked BETA, requires an organisation slug and answers with a nested
 * recommendation structure — a lot of surface to depend on for a list of AWS
 * regions that has changed a handful of times in five years. If a region is
 * missing here the user can still create the project in Supabase's dashboard and
 * link it, which is a far smaller failure than a beta endpoint changing shape.
 */
const REGIONS: { value: string; label: string }[] = [
	{ value: 'us-east-1', label: 'US East (N. Virginia)' },
	{ value: 'us-east-2', label: 'US East (Ohio)' },
	{ value: 'us-west-1', label: 'US West (N. California)' },
	{ value: 'us-west-2', label: 'US West (Oregon)' },
	{ value: 'ca-central-1', label: 'Canada (Central)' },
	{ value: 'sa-east-1', label: 'South America (São Paulo)' },
	{ value: 'eu-west-1', label: 'Europe (Ireland)' },
	{ value: 'eu-west-2', label: 'Europe (London)' },
	{ value: 'eu-west-3', label: 'Europe (Paris)' },
	{ value: 'eu-central-1', label: 'Europe (Frankfurt)' },
	{ value: 'eu-central-2', label: 'Europe (Zurich)' },
	{ value: 'eu-north-1', label: 'Europe (Stockholm)' },
	{ value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
	{ value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
	{ value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
	{ value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
	{ value: 'ap-northeast-2', label: 'Asia Pacific (Seoul)' },
	{ value: 'ap-east-1', label: 'Asia Pacific (Hong Kong)' }
];

/**
 * A password for a project we are creating.
 *
 * Generated rather than asked for, and never shown: the user has no reason to
 * type it, and Clopen stores it sealed the moment the project exists. Base64url
 * of 24 random bytes clears Supabase's strength rules without needing to know
 * what they are, and carries no characters that need escaping in a connection
 * string.
 */
function generatePassword(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A project that is not running cannot be connected to, and says so. */
function statusDetail(project: SupabaseApiProject): string {
	const parts = [project.region];
	if (project.status && project.status !== 'ACTIVE_HEALTHY') {
		parts.push(project.status.toLowerCase().replace(/_/g, ' '));
	}
	return parts.filter(Boolean).join(' · ');
}

export async function listSupabaseProjects(context: DbProviderContext): Promise<SupabaseApiProject[]> {
	return supabaseRequest<SupabaseApiProject[]>(supabaseCredentialsOf(context), '/v1/projects');
}

/**
 * The primary database's pooler configuration.
 *
 * The endpoint answers with an array — a project with read replicas has one
 * entry each — and the primary is the one this surface connects to. Picking the
 * first entry regardless would silently connect a read replica on some projects.
 */
async function poolerConfig(
	credentials: SupabaseCredentials,
	ref: string
): Promise<SupabaseApiPoolerConfig | null> {
	const configs = await supabaseRequest<SupabaseApiPoolerConfig[]>(
		credentials,
		`/v1/projects/${encodeURIComponent(ref)}/config/database/pooler`
	);
	if (!Array.isArray(configs) || configs.length === 0) return null;
	return configs.find((entry) => entry.database_type === 'PRIMARY') ?? configs[0];
}

export const supabaseDbAdapter: DbProviderAdapter = {
	provider: SUPABASE_PROVIDER_ID,
	driver: 'postgres',

	info(): DbProviderInfo {
		return {
			id: SUPABASE_PROVIDER_ID,
			name: 'Supabase',
			driver: 'postgres',
			description: 'Pick a project this token can reach.',
			// Session mode is correct for this client in every case the other two
			// are not, so it is the silent default and both escape hatches are
			// marked advanced. Transaction mode is genuinely a trap here — our
			// driver prepares statements — and a direct connection is IPv6-only on
			// projects created since 2024; offering all three up front asked the
			// user to choose between one right answer and two ways to fail.
			modes: [
				{
					id: SUPABASE_MODES.poolerSession,
					label: 'Pooler (session)',
					help: 'Works over IPv4. The right choice unless the pooler is unavailable.',
					isDefault: true
				},
				{
					id: SUPABASE_MODES.poolerTransaction,
					label: 'Pooler (transaction)',
					help: 'Breaks prepared statements, which this client uses.',
					isAdvanced: true
				},
				{
					id: SUPABASE_MODES.direct,
					label: 'Direct',
					help: 'IPv6 only on projects created since 2024.',
					isAdvanced: true
				}
			],
			secretFields: [
				{
					name: 'password',
					label: 'Database password',
					placeholder: 'Project database password',
					help: 'Project Settings → Database. Supabase cannot read it back, so it is stored here, encrypted.',
					isRequired: true
				}
			]
		};
	},

	async listDatabases(context: DbProviderContext): Promise<DbRemoteDatabase[]> {
		const credentials = supabaseCredentialsOf(context);
		// The organisation is fetched ALONGSIDE the projects, not for each of
		// them: a project carries only its org's slug, and an account with a
		// dozen projects in two organisations would otherwise ask twelve times
		// for two answers. A token without Organizations Read still gets a list —
		// it simply falls back to the slug the project already reported.
		const [projects, organizations] = await Promise.all([
			listSupabaseProjects(context),
			supabaseRequest<SupabaseApiOrganization[]>(credentials, '/v1/organizations').catch((error) => {
				debug.warn('db-client', 'Could not name Supabase organizations:', error);
				return [] as SupabaseApiOrganization[];
			})
		]);

		const names = new Map<string, string>();
		for (const organization of organizations ?? []) {
			if (organization?.slug) names.set(organization.slug, organization.name || organization.slug);
		}

		return projects.map((project) => ({
			ref: project.ref || project.id,
			name: project.name,
			detail: statusDetail(project),
			group: project.organization_slug
				? names.get(project.organization_slug) ?? project.organization_slug
				: null,
			status: project.status ?? null,
			isReady: project.status === READY_STATUS,
			isLinked: false
		}));
	},

	async resolveEndpoint(
		context: DbProviderContext,
		target: { remoteRef: string; mode: string }
	): Promise<DbProviderEndpoint> {
		const credentials = supabaseCredentialsOf(context);
		const ref = target.remoteRef;

		if (target.mode === SUPABASE_MODES.direct) {
			// The direct host is REPORTED per project rather than derived:
			// `db.<ref>.supabase.co` is a convention, not a guarantee, and a project
			// on a custom or older domain would be sent somewhere that does not
			// resolve. The convention is only the fallback.
			const project = await supabaseRequest<SupabaseApiProject>(
				credentials,
				`/v1/projects/${encodeURIComponent(ref)}`
			);
			const host = project?.database?.host ?? `db.${ref}.supabase.co`;
			return {
				host,
				port: DIRECT_PORT,
				username: 'postgres',
				database: 'postgres',
				// Supabase terminates TLS on every endpoint, but its certificate is
				// issued by its own CA, so demanding verification without also
				// shipping that CA would refuse every connection. `require` is the
				// honest setting: encrypted, not pinned.
				sslMode: 'require',
				options: { supabase: { ref, mode: target.mode } }
			};
		}

		const pooler = await poolerConfig(credentials, ref);
		if (!pooler) {
			throw new SupabaseError(
				`Supabase did not report a pooler for ${ref}. Choose a direct connection instead, or check the project is running.`,
				404,
				'config'
			);
		}

		const isTransaction = target.mode === SUPABASE_MODES.poolerTransaction;
		return {
			host: pooler.db_host,
			// The reported port belongs to whichever mode the project is configured
			// for, so it is only trusted when it matches the mode being asked for.
			port: isTransaction ? POOLER_TRANSACTION_PORT : POOLER_SESSION_PORT,
			// `postgres.<ref>` — the pooler routes on the username, so the plain
			// `postgres` that works on a direct connection fails here.
			username: pooler.db_user || `postgres.${ref}`,
			database: pooler.db_name || 'postgres',
			sslMode: 'require',
			options: { supabase: { ref, mode: target.mode } }
		};
	},

	async createOptions(context: DbProviderContext): Promise<DbProviderCreateOptions> {
		const credentials = supabaseCredentialsOf(context);

		// Listed organisations are trusted; derived ones are CHECKED but still
		// offered when the check cannot confirm them.
		//
		// Three facts, all confirmed against a live scoped token, and each one
		// killed a simpler design:
		//
		//  1. `/v1/organizations` answers `[]` with a 200 for a token that plainly
		//     reaches projects, so it is not the last word.
		//  2. A project's `organization_slug` names where that project lives, not
		//     somewhere this token may act — `/v1/organizations/{slug}` 403s for
		//     an organisation the user is merely a member of. Offering those
		//     unmarked produced a 403 after the form was filled in.
		//  3. But reading and writing are SEPARATE permissions: the same token
		//     that cannot read an organisation successfully created one. So
		//     dropping every unverifiable candidate removed a capability that
		//     works, which is its own kind of wrong.
		//
		// Hence: verify, and mark rather than hide. The caller decides how loudly
		// to say "this might fail", and a 403 now names the missing permission.
		const [listed, projects] = await Promise.all([
			supabaseRequest<SupabaseApiOrganization[]>(credentials, '/v1/organizations').catch((error) => {
				debug.warn('db-client', 'Could not list Supabase organizations:', error);
				return [] as SupabaseApiOrganization[];
			}),
			supabaseRequest<SupabaseApiProject[]>(credentials, '/v1/projects').catch(() => [] as SupabaseApiProject[])
		]);

		const groups = new Map<string, DbProviderCreateGroup>();
		for (const organization of listed ?? []) {
			if (!organization?.slug) continue;
			groups.set(organization.slug, {
				value: organization.slug,
				label: organization.name || organization.slug
			});
		}

		const candidates = new Set<string>();
		for (const project of projects ?? []) {
			const slug = project.organization_slug;
			// Only a slug is usable: `organization_id` is deprecated and the create
			// endpoint takes the slug.
			if (slug && !groups.has(slug)) candidates.add(slug);
		}

		await Promise.all(
			[...candidates].map(async (slug) => {
				try {
					const organization = await supabaseRequest<SupabaseApiOrganization>(
						credentials,
						`/v1/organizations/${encodeURIComponent(slug)}`
					);
					groups.set(slug, { value: slug, label: organization?.name || slug });
				} catch {
					groups.set(slug, {
						value: slug,
						label: slug,
						detail: 'unverified',
						isUnverified: true
					});
				}
			})
		);

		debug.log(
			'db-client',
			`Supabase create options: ${listed?.length ?? 0} listed, ${candidates.size} derived, ${groups.size} offered`
		);

		return {
			groupLabel: 'Organisation',
			groups: [...groups.values()],
			regionLabel: 'Region',
			regions: REGIONS,
			// Names the consequence rather than asking "are you sure". Creating a
			// project provisions real infrastructure against a real quota, and the
			// plan lives on the organisation, so which one is picked decides
			// whether this is free.
			notice:
				'This provisions a real Postgres database on Supabase. It counts against the organisation\'s project quota and its plan decides what it costs.',
			// Shown INSTEAD of the form when nothing is usable. The two real causes
			// are named because the fix differs: one is a token problem, the other
			// is a membership problem, and "Forbidden" distinguishes neither.
			// Short, and one instruction. The long version listed three ways out at
			// once and ended on "link it here", which named no action the reader
			// could take from where they were standing.
			emptyGroupsNotice:
				'This token reaches no organisation — create one, or regenerate the token with Organizations Read.',
			canCreateGroup: true,
			createGroupNotice: 'A new organisation is a billing entity and starts on the free plan.'
		};
	},

	/**
	 * Create an organisation.
	 *
	 * `POST /v1/organizations` takes a name and nothing else — no plan, no
	 * region — and answers with the slug the create-project call needs. It is a
	 * billing entity, so the dialog names that before the button; new
	 * organisations start on the free plan.
	 */
	async createGroup(
		context: DbProviderContext,
		input: { name: string }
	): Promise<{ value: string; label: string }> {
		const created = await supabaseRequest<SupabaseApiOrganization>(
			supabaseCredentialsOf(context),
			'/v1/organizations',
			{ method: 'POST', body: { name: input.name.trim() } }
		);
		if (!created?.slug) {
			throw new SupabaseError(
				'Supabase created the organisation but did not report its slug, so it cannot be used here yet. It will appear after a refresh.',
				502,
				'error'
			);
		}
		return { value: created.slug, label: created.name || created.slug };
	},

	async createDatabase(
		context: DbProviderContext,
		input: { name: string; group: string; region: string }
	): Promise<{ ref: string; secrets: Record<string, string> }> {
		const password = generatePassword();
		const created = await supabaseRequest<SupabaseApiProject>(
			supabaseCredentialsOf(context),
			'/v1/projects',
			{
				method: 'POST',
				body: {
					name: input.name,
					organization_slug: input.group,
					db_pass: password,
					// `region_selection` rather than the older `region` string, which
					// the API document marks deprecated. The shape is the documented
					// one: a discriminated object, not a bare code.
					region_selection: { type: 'specific', code: input.region }
				},
				// Provisioning is real work upstream, and aborting at the read budget
				// would report a timeout for a project that now exists.
				timeoutMs: SUPABASE_SLOW_TIMEOUT_MS
			}
		);

		const ref = created?.ref || created?.id;
		if (!ref) {
			throw new SupabaseError(
				'Supabase accepted the project but did not report its ref, so it cannot be linked automatically. It will be in the list once it finishes provisioning.',
				502,
				'error'
			);
		}
		return { ref, secrets: { password } };
	},

	/**
	 * Delete a project.
	 *
	 * Irreversible, and the API offers no undo — there is no trash. The confirm
	 * that guards it names the database rather than asking "are you sure",
	 * because the name is the thing someone can check against what they meant.
	 */
	async deleteDatabase(context: DbProviderContext, remoteRef: string): Promise<void> {
		await supabaseRequest(
			supabaseCredentialsOf(context),
			`/v1/projects/${encodeURIComponent(remoteRef)}`,
			{ method: 'DELETE', timeoutMs: SUPABASE_SLOW_TIMEOUT_MS }
		);
	},

	/**
	 * Rename a project.
	 *
	 * `PATCH /v1/projects/{ref}` takes a name and nothing else — it is the only
	 * field of a project the Management API lets us change. Organisations have
	 * no PATCH at all, which is why this adapter renames databases and not
	 * groups.
	 */
	async renameDatabase(context: DbProviderContext, remoteRef: string, name: string): Promise<void> {
		await supabaseRequest(
			supabaseCredentialsOf(context),
			`/v1/projects/${encodeURIComponent(remoteRef)}`,
			{ method: 'PATCH', body: { name } }
		);
	},

	async probe(context: DbProviderContext): Promise<{ status: IntegrationStatus; detail: string | null }> {
		try {
			const projects = await listSupabaseProjects(context);
			if (projects.length === 0) {
				return {
					status: 'needs_config',
					detail: 'The token works but reaches no projects — check which Supabase user it belongs to.'
				};
			}
			const plural = projects.length === 1 ? 'project' : 'projects';
			return { status: 'ok', detail: `${projects.length} ${plural} reachable` };
		} catch (error) {
			if (error instanceof SupabaseError) {
				const status: IntegrationStatus = error.kind === 'auth'
					? 'needs_auth'
					: error.kind === 'config' ? 'needs_config' : 'error';
				return { status, detail: error.message };
			}
			return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
		}
	}
};
