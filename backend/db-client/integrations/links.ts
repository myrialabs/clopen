/**
 * Linking a remote database into DB Client.
 *
 * The asynchronous half of the projection: this is where a provider is asked
 * where a database answers, and the answer is stored on the link so the
 * synchronous projector never has to ask again. Every mutation here ends in
 * `reproject()`, which is what keeps the connection list derived rather than
 * merely created once and then drifting.
 */

import {
	dbClientConnectionQueries,
	integrationAccountQueries,
	integrationDbLinkQueries,
	integrationProjectionQueries,
	type IntegrationAccountRow,
	type IntegrationDbLinkRow
} from '$backend/database/queries';
import { getProvider, reproject } from '$backend/integrations';
import type {
	DbAccountLinkInfo,
	DbClientManagedBy,
	DbProviderCreateOptions,
	DbProviderInfo,
	DbRemoteDatabase
} from '$shared/types/db-client';
import { connectionManager } from '../connection-manager';
import { getDbProvider, listDbProviders } from '../providers/registry';
import type { DbProviderAdapter, DbProviderContext } from '../providers/types';
import { connectionIdOf } from './projector';
import { debug } from '$shared/utils/logger';

function requireAccount(accountId: string): IntegrationAccountRow {
	const account = integrationAccountQueries.getById(accountId);
	if (!account) throw new Error('Integration account not found');
	return account;
}

function requireAdapter(provider: string): DbProviderAdapter {
	const adapter = getDbProvider(provider);
	if (!adapter) throw new Error(`"${provider}" is not a database provider`);
	return adapter;
}

function contextFor(account: IntegrationAccountRow): DbProviderContext {
	return {
		accountId: account.id,
		credentials: integrationAccountQueries.credentialsOf(account)
	};
}

/**
 * Re-project, then drop the live adapters for the rows it touched.
 *
 * `connectionManager` keeps an open driver per connection, and it was opened
 * with the settings the row had at the time. Rotating a password or switching
 * to a different pooler mode rewrites the row but leaves that adapter
 * connected — so the change appears to have worked while every query keeps
 * going to the old endpoint with the old credential until the pool happens to
 * sweep it. `db-client:update` already releases for exactly this reason; the
 * projection path has to as well.
 */
async function reprojectAndRelease(accountId: string): Promise<void> {
	const before = integrationDbLinkQueries
		.getForAccount(accountId)
		.map((link) => connectionIdOf(link))
		.filter((id): id is string => id !== null);

	reproject(accountId);

	const after = integrationDbLinkQueries
		.getForAccount(accountId)
		.map((link) => connectionIdOf(link))
		.filter((id): id is string => id !== null);

	for (const id of new Set([...before, ...after])) {
		await connectionManager.release(id);
	}
}

function defaultModeOf(adapter: DbProviderAdapter): string {
	const modes = adapter.info().modes;
	return (modes.find((mode) => mode.isDefault) ?? modes[0])?.id ?? 'default';
}

function toLinkInfo(link: IntegrationDbLinkRow, account: IntegrationAccountRow): DbAccountLinkInfo {
	return {
		id: link.id,
		accountId: link.account_id,
		provider: account.provider,
		accountLabel: account.label,
		remoteRef: link.remote_ref,
		label: link.label,
		driver: link.driver,
		mode: link.mode,
		connectionId: connectionIdOf(link),
		configuredSecrets: Object.entries(integrationDbLinkQueries.secretsOf(link))
			.filter(([, value]) => typeof value === 'string' && value.length > 0)
			.map(([name]) => name),
		detected: link.detected === 1
	};
}

/**
 * Refuse a link that is missing a secret the provider says it needs.
 *
 * Checked before the row is written, for the reason the account layer checks
 * its own required fields: a link saved without its password looks connected
 * and fails much later, inside a driver, with a message about authentication
 * rather than about configuration.
 */
function assertRequiredSecrets(adapter: DbProviderAdapter, secrets: Record<string, string>): void {
	const missing = adapter.info().secretFields
		.filter((field) => field.isRequired && !(secrets[field.name] ?? '').trim())
		.map((field) => field.label);
	if (missing.length > 0) {
		throw new Error(`${adapter.info().name} needs ${missing.join(', ')}`);
	}
}

/**
 * Poll until a newly created database reports itself connectable.
 *
 * Bounded, and a long budget rather than an unbounded one: a call that cannot
 * tell "still provisioning" from "this will never answer" is worse than one
 * that gives up and says so. Supabase takes roughly a minute for a small
 * project, so three minutes is generous without being a hang.
 */
const READY_POLL_INTERVAL_MS = 5_000;
const READY_POLL_BUDGET_MS = 180_000;

async function waitForReady(
	adapter: DbProviderAdapter,
	context: DbProviderContext,
	ref: string
): Promise<boolean> {
	const deadline = Date.now() + READY_POLL_BUDGET_MS;

	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
		try {
			const databases = await adapter.listDatabases(context);
			const match = databases.find((database) => database.ref === ref);
			if (match?.isReady) return true;
		} catch (error) {
			// A provider that is briefly unreachable while it provisions is the
			// normal case, not a reason to abandon a database that now exists.
			debug.log('db-client', `Readiness poll for ${ref} failed, retrying: ${error instanceof Error ? error.message : error}`);
		}
	}

	return false;
}

export const dbLinks = {
	/** Every database provider, as the link dialog renders them. */
	providers(): DbProviderInfo[] {
		return listDbProviders().map((adapter) => adapter.info());
	},

	/** Connected, enabled accounts that can supply database connections. */
	accounts(): { accountId: string; provider: string; label: string; status: string }[] {
		return listDbProviders().flatMap((adapter) =>
			integrationAccountQueries
				.getByProvider(adapter.provider)
				.filter((account) => account.is_enabled === 1)
				.filter((account) => integrationAccountQueries.capabilitiesOf(account).includes('database'))
				.map((account) => ({
					accountId: account.id,
					provider: account.provider,
					label: account.label,
					status: account.status
				}))
		);
	},

	/** Every remote database this account can reach, flagged with what is linked. */
	async remoteDatabases(accountId: string): Promise<DbRemoteDatabase[]> {
		const account = requireAccount(accountId);
		const adapter = requireAdapter(account.provider);
		const linked = new Set(
			integrationDbLinkQueries.getForAccount(accountId).map((link) => link.remote_ref)
		);
		const databases = await adapter.listDatabases(contextFor(account));
		return databases.map((database) => ({ ...database, isLinked: linked.has(database.ref) }));
	},

	links(accountId: string): DbAccountLinkInfo[] {
		const account = requireAccount(accountId);
		return integrationDbLinkQueries.getForAccount(accountId).map((link) => toLinkInfo(link, account));
	},

	/** Every link on the install, which is what the panel badges its list from. */
	allLinks(): DbAccountLinkInfo[] {
		return listDbProviders().flatMap((adapter) =>
			integrationAccountQueries.getByProvider(adapter.provider).flatMap((account) =>
				integrationDbLinkQueries.getForAccount(account.id).map((link) => toLinkInfo(link, account))
			)
		);
	},

	async create(input: {
		accountId: string;
		remoteRef: string;
		label?: string;
		mode?: string;
		secrets: Record<string, string>;
		detected?: boolean;
		/** Write the row now and work out where it answers later. */
		deferEndpoint?: boolean;
	}): Promise<DbAccountLinkInfo> {
		const account = requireAccount(input.accountId);
		const adapter = requireAdapter(account.provider);
		assertRequiredSecrets(adapter, input.secrets);

		if (integrationDbLinkQueries.getByRef(input.accountId, input.remoteRef)) {
			throw new Error('That database is already linked to this account.');
		}

		const mode = input.mode ?? defaultModeOf(adapter);
		// Resolved BEFORE the row is written. A link whose endpoint could not be
		// resolved is not a link — it is a row that projects nothing, and failing
		// here puts the error in the dialog that caused it rather than in a
		// connection list that silently stayed the same length.
		//
		// `deferEndpoint` is the one exception, and it exists for a single caller:
		// a database we have just CREATED is not answering yet, and its generated
		// password only exists in memory until this row is written. Storing the
		// secret first and resolving later is the only ordering where a slow
		// provision cannot strand a password that nothing can recover.
		const endpoint = input.deferEndpoint
			? null
			: await adapter.resolveEndpoint(contextFor(account), {
				remoteRef: input.remoteRef,
				mode
			});

		const link = integrationDbLinkQueries.create({
			accountId: input.accountId,
			remoteRef: input.remoteRef,
			label: (input.label ?? '').trim() || input.remoteRef,
			driver: adapter.driver,
			mode,
			secrets: input.secrets,
			config: endpoint ? { endpoint } : {},
			detected: input.detected
		});

		await reprojectAndRelease(input.accountId);
		debug.log('db-client', `Linked ${account.provider}:${input.remoteRef} as ${link.id}`);
		return toLinkInfo(integrationDbLinkQueries.getById(link.id)!, account);
	},

	/** What the create-a-database form needs, or null when the provider cannot. */
	async createOptions(accountId: string): Promise<DbProviderCreateOptions | null> {
		const account = requireAccount(accountId);
		const adapter = requireAdapter(account.provider);
		if (!adapter.createOptions) return null;
		return adapter.createOptions(contextFor(account));
	},

	/**
	 * Delete a database AT THE PROVIDER, and drop its link.
	 *
	 * Unlinking and deleting are deliberately different operations: one removes
	 * Clopen's connection, the other destroys the database. The link goes first
	 * so a successful delete cannot leave a projection pointing at something that
	 * no longer exists — and if the remote delete then fails, the user has lost a
	 * link they can recreate rather than a database they cannot.
	 */
	async deleteDatabase(accountId: string, remoteRef: string): Promise<void> {
		const account = requireAccount(accountId);
		const adapter = requireAdapter(account.provider);
		if (!adapter.deleteDatabase) {
			throw new Error(`${adapter.info().name} cannot delete databases from here`);
		}

		const link = integrationDbLinkQueries.getByRef(accountId, remoteRef);
		if (link) await this.remove(link.id);

		await adapter.deleteDatabase(contextFor(account), remoteRef);
		debug.log('db-client', `Deleted ${account.provider} database ${remoteRef}`);
	},

	/**
	 * Rename a database AT THE PROVIDER.
	 *
	 * The link's own label is left alone on purpose. It is what this install
	 * calls the connection and is edited in the link form; overwriting a name
	 * someone chose here because the project was renamed elsewhere would be a
	 * second, unasked-for change.
	 */
	async renameDatabase(accountId: string, remoteRef: string, name: string): Promise<void> {
		const account = requireAccount(accountId);
		const adapter = requireAdapter(account.provider);
		if (!adapter.renameDatabase) {
			throw new Error(`${adapter.info().name} cannot rename databases from here`);
		}
		await adapter.renameDatabase(contextFor(account), remoteRef, name);
		debug.log('db-client', `Renamed ${account.provider} database ${remoteRef}`);
	},

	/**
	 * Create the owning container — a Supabase organisation.
	 *
	 * Separate from `createDatabase` because the consequence is different: this
	 * creates a BILLING entity, not a database. It exists so an account whose
	 * token reaches no organisation is not a dead end Clopen can only point away
	 * from.
	 */
	async createGroup(accountId: string, name: string): Promise<{ value: string; label: string }> {
		const account = requireAccount(accountId);
		const adapter = requireAdapter(account.provider);
		if (!adapter.createGroup) {
			throw new Error(`${adapter.info().name} cannot create one from here`);
		}
		const group = await adapter.createGroup(contextFor(account), { name });
		debug.log('db-client', `Created ${account.provider} group ${group.value}`);
		return group;
	},

	/**
	 * Create a database at the provider and link it.
	 *
	 * The ORDER here is the whole design. A freshly created database is not
	 * answering yet, and its password exists only in the reply we just received —
	 * no API can read it back later. So the link row is written FIRST, with the
	 * secret, and the endpoint is resolved afterwards. Every other ordering has a
	 * window where a slow provision, a dropped socket or a restart leaves the user
	 * with a real database whose password nothing holds.
	 *
	 * The wait is bounded and failing it is NOT an error: the project exists, the
	 * link exists, and saving the link is the retry. Reporting `ready: false`
	 * lets the dialog say what actually happened instead of implying the whole
	 * thing failed.
	 */
	async createDatabase(input: {
		accountId: string;
		name: string;
		group: string;
		region: string;
	}): Promise<{ link: DbAccountLinkInfo; ready: boolean }> {
		const account = requireAccount(input.accountId);
		const adapter = requireAdapter(account.provider);
		if (!adapter.createDatabase) {
			throw new Error(`${adapter.info().name} cannot create databases from here`);
		}

		const context = contextFor(account);
		const created = await adapter.createDatabase(context, {
			name: input.name.trim(),
			group: input.group,
			region: input.region
		});

		const link = await this.create({
			accountId: input.accountId,
			remoteRef: created.ref,
			label: input.name.trim(),
			secrets: created.secrets,
			deferEndpoint: true
		});
		debug.log('db-client', `Created ${account.provider} database ${created.ref}, linked as ${link.id}`);

		const ready = await waitForReady(adapter, context, created.ref);
		if (!ready) {
			debug.log('db-client', `${created.ref} is still provisioning — the link will resolve on save`);
			return { link, ready: false };
		}

		// Now it answers: resolve the endpoint and let the projection run.
		return { link: await this.update(link.id, { refreshEndpoint: true }), ready: true };
	},

	/**
	 * Change a link's label, mode or secret.
	 *
	 * The endpoint is re-resolved only when the mode changes or the caller asks:
	 * a password rotation does not move the host, and making every save wait on
	 * the provider's API would be a slow way to learn nothing new.
	 */
	async update(
		linkId: string,
		patch: { label?: string; mode?: string; secrets?: Record<string, string>; refreshEndpoint?: boolean }
	): Promise<DbAccountLinkInfo> {
		const link = integrationDbLinkQueries.getById(linkId);
		if (!link) throw new Error('Database link not found');
		const account = requireAccount(link.account_id);
		const adapter = requireAdapter(account.provider);

		// Empty means "not re-typed", the rule every credential form in Clopen
		// already follows, so the merge happens here rather than in the query.
		const secrets = { ...integrationDbLinkQueries.secretsOf(link) };
		for (const [name, value] of Object.entries(patch.secrets ?? {})) {
			if (typeof value === 'string' && value.length > 0) secrets[name] = value;
		}
		assertRequiredSecrets(adapter, secrets);

		const mode = patch.mode ?? link.mode;
		const config = integrationDbLinkQueries.configOf<Record<string, unknown>>(link);
		// A link with NO endpoint is one that was deferred — a database that was
		// still provisioning when it was created. Saving it is the retry, so the
		// user never has to know which button re-resolves.
		if (patch.refreshEndpoint || mode !== link.mode || !config.endpoint) {
			config.endpoint = await adapter.resolveEndpoint(contextFor(account), {
				remoteRef: link.remote_ref,
				mode
			});
		}

		integrationDbLinkQueries.update(linkId, {
			label: patch.label?.trim() || undefined,
			mode,
			secrets,
			config
		});

		await reprojectAndRelease(link.account_id);
		return toLinkInfo(integrationDbLinkQueries.getById(linkId)!, account);
	},

	/**
	 * Drop a link.
	 *
	 * The row is deleted first and `reproject()` does the rest: the connection
	 * this link owned is no longer in the projected set, so the pass releases it
	 * exactly the way disconnecting the whole account would — deleting a row we
	 * created, handing back one we adopted.
	 */
	async remove(linkId: string): Promise<void> {
		const link = integrationDbLinkQueries.getById(linkId);
		if (!link) return;
		const accountId = link.account_id;
		const connectionId = connectionIdOf(link);
		integrationDbLinkQueries.remove(linkId);
		reproject(accountId);
		// The row is gone or handed back; either way the open driver for it is
		// no longer ours to keep.
		if (connectionId) await connectionManager.release(connectionId);
		debug.log('db-client', `Unlinked ${linkId}`);
	},

	/**
	 * Who owns each projected connection, keyed by connection id.
	 *
	 * One pass over the projections rather than a lookup per connection: the
	 * panel asks this for a whole list on every refresh.
	 */
	managedIndex(): Map<string, DbClientManagedBy> {
		const index = new Map<string, DbClientManagedBy>();
		const linksByAccount = new Map<string, Map<string, IntegrationDbLinkRow>>();

		const linksOf = (accountId: string): Map<string, IntegrationDbLinkRow> => {
			let cached = linksByAccount.get(accountId);
			if (!cached) {
				cached = new Map();
				for (const link of integrationDbLinkQueries.getForAccount(accountId)) {
					const connectionId = connectionIdOf(link);
					if (connectionId) cached.set(connectionId, link);
				}
				linksByAccount.set(accountId, cached);
			}
			return cached;
		};

		for (const projection of integrationProjectionQueries.getAllByKind('db_client_connection')) {
			const account = integrationAccountQueries.getById(projection.account_id);
			if (!account) continue;

			const link = linksOf(projection.account_id).get(projection.target_id) ?? null;

			index.set(projection.target_id, {
				accountId: account.id,
				provider: account.provider,
				providerName: getProvider(account.provider)?.name ?? account.provider,
				accountLabel: account.label,
				linkId: link?.id ?? null,
				remoteRef: link?.remote_ref ?? null,
				adopted: projection.adopted === 1
			});
		}

		return index;
	},

	/** The owner of one connection, or null when it was typed in by hand. */
	managedBy(connectionId: string): DbClientManagedBy | null {
		return this.managedIndex().get(connectionId) ?? null;
	},

	/** Attach ownership to a list of connections on its way to the panel. */
	decorate<T extends { id: string }>(connections: T[]): (T & { managedBy: DbClientManagedBy | null })[] {
		const index = this.managedIndex();
		return connections.map((connection) => ({
			...connection,
			managedBy: index.get(connection.id) ?? null
		}));
	},

	/** The link behind a connection, for the surfaces that need its remote ref. */
	linkForConnection(connectionId: string): { link: IntegrationDbLinkRow; account: IntegrationAccountRow } | null {
		const projection = integrationProjectionQueries.getByTarget('db_client_connection', connectionId);
		if (!projection) return null;
		const account = integrationAccountQueries.getById(projection.account_id);
		if (!account) return null;
		const link = integrationDbLinkQueries
			.getForAccount(account.id)
			.find((candidate) => connectionIdOf(candidate) === connectionId);
		return link ? { link, account } : null;
	},

	/** Health for the hub, delegated to whichever adapter owns the provider. */
	async probe(accountId: string) {
		const account = requireAccount(accountId);
		const adapter = getDbProvider(account.provider);
		if (!adapter) return null;
		if (!integrationAccountQueries.capabilitiesOf(account).includes('database')) return null;
		return adapter.probe(contextFor(account));
	},

	/** Connections a projection owns, so the panel can refuse to delete them. */
	isManaged(connectionId: string): boolean {
		return integrationProjectionQueries.getByTarget('db_client_connection', connectionId) !== null;
	},

	/** Every projected connection id — used by tests and the audit path. */
	projectedConnectionIds(): string[] {
		return integrationProjectionQueries
			.getAllByKind('db_client_connection')
			.map((projection) => projection.target_id)
			.filter((id) => dbClientConnectionQueries.get(id) !== null);
	}
};
