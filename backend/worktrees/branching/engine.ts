/**
 * Where a worktree's database comes from, behind one interface.
 *
 * The feature used to be spelled "ask the provider to cut a branch", which made
 * it a Neon feature by construction: a database with no vendor API behind it
 * had no way in at all. What a worktree actually needs is *a database of its
 * own*, and branching is one of several ways to get one — so the provider
 * adapter moves down a level and this interface takes its place.
 *
 * TWO IMPLEMENTATIONS, and the general one is not the vendor one:
 *
 *  - **account** — a provider that branches natively. Neon cuts copy-on-write
 *    in its own infrastructure, which nothing here can match on speed or cost.
 *    Delegates to `BranchProviderAdapter` unchanged.
 *  - **connection** — any database DB Client can already reach. A sibling
 *    database on the same server, made with that engine's own primitives (see
 *    `db-client/cloning.ts`). This is the one that makes the feature true of
 *    local Postgres, of MySQL, of SQLite and of Supabase.
 *
 * Everything downstream — the rows, the dotenv write, the orphan sweep, the
 * projected connection — is written against this interface and no longer knows
 * which kind answered.
 */

import path from 'path';
import {
	dbClientConnectionQueries,
	integrationAccountQueries,
	worktreeBranchQueries,
	type IntegrationAccountRow,
	type WorktreeBranchBindingRow,
	type WorktreeBranchRow
} from '$backend/database/queries';
import { getProvider } from '$backend/integrations';
import { buildConnectionUrl } from '$backend/db-client/connection-url';
import {
	canBranchFrom,
	cloneDatabase,
	cloneSupport,
	dropClonedDatabase,
	listDatabaseNames,
	type DbCloneMode
} from '$backend/db-client/cloning';
import type { DbClientConnection, DbDriver } from '$shared/types/db-client';
import type {
	BranchConnection,
	BranchDataMode,
	BranchSourceKind,
	BranchSourceOption,
	RemoteBranch
} from '$shared/types/worktree-branching';
import { getBranchProvider, listBranchProviders } from './registry';
import { branchDatabaseNameFor, isClopenBranchName, isClopenDatabaseName } from './naming';
import { debug } from '$shared/utils/logger';

/** What a create actually produced, including how. */
export interface CreatedBranchResult {
	ref: string;
	name: string;
	connection: BranchConnection;
	/** `template`, `server-copy`, `row-copy`, `file-copy`, … or null for native. */
	strategy: string | null;
	/** One sentence naming what the copy did not carry, or null. */
	notice: string | null;
}

export interface BranchEngine {
	sourceKind: BranchSourceKind;
	sourceId: string;
	sourceLabel: string;
	/** Integration provider id for an account, driver id for a connection. */
	provider: string;
	providerName: string;
	noun: string;
	isNative: boolean;
	parentRef: string;
	parentName: string;
	/** What a copy here does not carry, known before it runs. */
	notice: string | null;

	create(input: {
		/** The deterministic name from `naming.ts`. */
		name: string;
		worktreeSlug: string;
		projectName: string;
		pooled: boolean;
		dataMode: BranchDataMode;
	}): Promise<CreatedBranchResult>;

	delete(branchRef: string): Promise<void>;

	/** Everything at the source that looks like ours, for the orphan sweep. */
	list(): Promise<RemoteBranch[]>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* ----------------------------------------------------------------- account */

function accountEngine(input: {
	account: IntegrationAccountRow;
	parentRef: string;
	parentName: string;
}): BranchEngine | null {
	const adapter = getBranchProvider(input.account.provider);
	if (!adapter) return null;

	const context = {
		accountId: input.account.id,
		credentials: integrationAccountQueries.credentialsOf(input.account)
	};
	const info = adapter.info();

	return {
		sourceKind: 'account',
		sourceId: input.account.id,
		sourceLabel: input.account.label,
		provider: input.account.provider,
		providerName: getProvider(input.account.provider)?.name ?? input.account.provider,
		noun: info.noun,
		isNative: true,
		parentRef: input.parentRef,
		parentName: input.parentName,
		// A native branch is the parent, atomically. There is nothing it fails to
		// bring across, so there is nothing to warn about.
		notice: null,

		async create(options) {
			const created = await adapter.createBranch(context, {
				parentRef: input.parentRef,
				name: options.name,
				pooled: options.pooled
			});
			return {
				ref: created.ref,
				name: created.name,
				connection: created.connection,
				strategy: 'native',
				notice: null
			};
		},

		async delete(branchRef) {
			await adapter.deleteBranch(context, { parentRef: input.parentRef, branchRef });
		},

		async list() {
			const branches = await adapter.listBranches(context, input.parentRef);
			return branches.filter((branch) => !branch.isDefault && isClopenBranchName(branch.name));
		}
	};
}

/* -------------------------------------------------------------- connection */

/** What each driver calls the thing a worktree gets. */
function nounFor(driver: DbDriver): string {
	if (driver === 'redis') return 'database';
	if (driver === 'sqlite') return 'copy';
	return 'copy';
}

const DRIVER_NAMES: Record<DbDriver, string> = {
	postgres: 'PostgreSQL',
	mysql: 'MySQL',
	sqlite: 'SQLite',
	mongodb: 'MongoDB',
	redis: 'Redis',
	mssql: 'SQL Server'
};

/** Redis has sixteen numbered databases and no way to make a seventeenth. */
const REDIS_DATABASES = 16;

/**
 * The name the copy will have.
 *
 * Three shapes, because "a database" means three different things. SQLite's is
 * a FILE, so the copy is a path beside the original — and putting it beside
 * rather than inside the worktree is deliberate: a worktree is a disposable
 * file copy, and a database inside one would be copied again by the next
 * "Apply to Main".
 */
function targetNameFor(input: {
	driver: DbDriver;
	parentRef: string;
	projectName: string;
	worktreeSlug: string;
	taken: Set<string>;
}): string {
	const base = branchDatabaseNameFor({
		projectName: input.projectName,
		worktreeSlug: input.worktreeSlug
	});

	if (input.driver === 'sqlite') {
		const directory = path.dirname(input.parentRef);
		const extension = path.extname(input.parentRef) || '.db';
		return path.join(directory, `${base}${extension}`);
	}

	if (input.driver === 'redis') {
		// An index, not a name — so the only question is which one is free, and
		// the parent's own index is never a candidate.
		const parent = Number(input.parentRef) || 0;
		for (let index = 0; index < REDIS_DATABASES; index += 1) {
			if (index === parent) continue;
			if (!input.taken.has(String(index))) return String(index);
		}
		throw new Error(
			`Every Redis database on this server is already in use, so there is none left for this worktree.`
		);
	}

	return base;
}

/** The branch's own connection, derived from the parent's with a new database. */
function connectionFor(parent: DbClientConnection, database: string): BranchConnection {
	const target: DbClientConnection = { ...parent, database };
	return {
		uri: buildConnectionUrl(target),
		host: parent.host ?? '',
		port: parent.port ?? 0,
		username: parent.username ?? '',
		password: parent.password ?? '',
		database,
		sslMode: parent.sslMode
	};
}

function connectionEngine(input: {
	connection: DbClientConnection;
	parentRef: string;
	parentName: string;
}): BranchEngine {
	const driver = input.connection.driver;
	const support = cloneSupport(driver);

	return {
		sourceKind: 'connection',
		sourceId: input.connection.id,
		sourceLabel: input.connection.name,
		provider: driver,
		providerName: DRIVER_NAMES[driver],
		noun: nounFor(driver),
		isNative: false,
		parentRef: input.parentRef,
		parentName: input.parentName,
		notice: support.notice,

		async create(options) {
			// Which names are already spoken for, so Redis can find a free index
			// and every other driver can fail loudly rather than colliding.
			const taken = new Set(
				worktreeBranchQueries
					.getForSourceConnection(input.connection.id)
					.map((row) => row.branch_ref)
			);

			const target = targetNameFor({
				driver,
				parentRef: input.parentRef,
				projectName: options.projectName,
				worktreeSlug: options.worktreeSlug,
				taken
			});

			const result = await cloneDatabase({
				connection: input.connection,
				source: input.parentRef,
				target,
				mode: options.dataMode as DbCloneMode
			});

			return {
				ref: result.database,
				name: result.database,
				connection: connectionFor(input.connection, result.database),
				strategy: result.strategy,
				notice: result.notice
			};
		},

		async delete(branchRef) {
			await dropClonedDatabase({ connection: input.connection, database: branchRef });
		},

		async list() {
			if (driver === 'sqlite' || driver === 'redis') {
				// Neither has a list worth sweeping: SQLite's databases are files in
				// a directory Clopen does not own, and Redis's are sixteen fixed
				// indexes that always exist. Reporting those as leaks would report
				// the server's own shape as a problem.
				return [];
			}
			const names = await listDatabaseNames(input.connection.id);
			return names.filter(isClopenDatabaseName).map((name) => ({
				ref: name,
				name,
				createdAt: null,
				isDefault: false,
				sizeBytes: null
			}));
		}
	};
}

/* ---------------------------------------------------------------- resolving */

export type EngineResolution =
	| { ok: true; engine: BranchEngine }
	| { ok: false; reason: string | null };

/**
 * The engine behind one binding, or a sentence saying why there is none.
 *
 * Returns a reason rather than throwing, because every caller on the worktree
 * create path has to keep going regardless — and a reason a user can read beats
 * a stack trace in a log nobody opens.
 */
export function resolveEngine(binding: WorktreeBranchBindingRow | null): EngineResolution {
	// No binding at all is not a problem — it is the default state of every
	// project — so there is nothing to report.
	if (!binding) return { ok: false, reason: null };

	if (binding.source_kind === 'connection') {
		const connection = binding.connection_id
			? dbClientConnectionQueries.get(binding.connection_id)
			: null;
		if (!connection) {
			return {
				ok: false,
				reason: 'The connection this project copies its database from has been deleted.'
			};
		}
		if (!canBranchFrom(connection)) {
			return {
				ok: false,
				reason: `Clopen cannot copy a database over an SSH tunnel, so "${connection.name}" cannot give a worktree one.`
			};
		}
		return {
			ok: true,
			engine: connectionEngine({
				connection,
				parentRef: binding.parent_ref,
				parentName: binding.parent_name
			})
		};
	}

	const account = binding.account_id
		? integrationAccountQueries.getById(binding.account_id)
		: null;
	if (!account) {
		return { ok: false, reason: 'The account this project branched from has been disconnected.' };
	}
	if (account.is_enabled !== 1) {
		return { ok: false, reason: `The ${account.label} account is switched off, so no branch was created.` };
	}
	if (!integrationAccountQueries.capabilitiesOf(account).includes('worktree-branching')) {
		return { ok: false, reason: `Worktree branching is switched off for the ${account.label} account.` };
	}

	const engine = accountEngine({
		account,
		parentRef: binding.parent_ref,
		parentName: binding.parent_name
	});
	if (!engine) {
		return { ok: false, reason: `"${account.provider}" cannot create database branches.` };
	}
	return { ok: true, engine };
}

/** The engine for a branch ROW, which may outlive its binding. */
export function resolveEngineForBranch(row: WorktreeBranchRow): BranchEngine | null {
	if (row.source_kind === 'connection') {
		const connection = row.source_connection_id
			? dbClientConnectionQueries.get(row.source_connection_id)
			: null;
		if (!connection) return null;
		return connectionEngine({
			connection,
			parentRef: row.parent_ref,
			parentName: row.parent_ref
		});
	}

	const account = row.account_id ? integrationAccountQueries.getById(row.account_id) : null;
	if (!account) return null;
	return accountEngine({ account, parentRef: row.parent_ref, parentName: row.parent_ref });
}

/* ------------------------------------------------------------------ sources */

/** Who is asking, so the list only offers what they may actually use. */
export interface BranchPrincipal {
	userId: string;
	isAdmin: boolean;
}

/**
 * Everywhere a worktree database could come from.
 *
 * Accounts and connections in ONE list, ordered native-first, because the user
 * is choosing which database and not which mechanism. The mechanism is carried
 * on each row as `isNative` and `notice` so the dialog can say what it costs.
 *
 * SCOPED TO THE CALLER, and the two halves scope differently. An integration
 * account belongs to the INSTALL and spends its quota, so it is admin-only —
 * the same rule `db-client:link` follows. A DB Client connection belongs to
 * whoever saved it, so a member sees their own and an admin sees every one;
 * anything else would let a member copy a database from a credential they
 * cannot otherwise reach.
 */
export function listBranchSources(principal: BranchPrincipal): BranchSourceOption[] {
	const sources: BranchSourceOption[] = [];

	for (const adapter of principal.isAdmin ? listBranchProviders() : []) {
		for (const account of integrationAccountQueries.getByProvider(adapter.provider)) {
			if (account.is_enabled !== 1) continue;
			if (!integrationAccountQueries.capabilitiesOf(account).includes('worktree-branching')) continue;
			sources.push({
				kind: 'account',
				id: account.id,
				label: account.label,
				provider: account.provider,
				providerName: getProvider(account.provider)?.name ?? account.provider,
				noun: adapter.info().noun,
				isNative: true,
				notice: null,
				status: account.status
			});
		}
	}

	for (const connection of dbClientConnectionQueries.listForUser(principal.userId, principal.isAdmin)) {
		if (!canBranchFrom(connection)) continue;
		// A connection that a branch already projected is not a parent: copying a
		// worktree's own copy would nest one disposable database inside another.
		if (connection.options?.worktreeBranch) continue;
		sources.push({
			kind: 'connection',
			id: connection.id,
			label: connection.name,
			provider: connection.driver,
			providerName: DRIVER_NAMES[connection.driver],
			noun: nounFor(connection.driver),
			isNative: false,
			notice: cloneSupport(connection.driver).notice,
			status: 'ok'
		});
	}

	return sources;
}

/**
 * The databases one connection could copy from.
 *
 * SQLite answers with its own file and Redis with its numbered indexes, because
 * for those two "which database" has an answer that needs no round trip — and
 * a driver that cannot list at all still has the one it is pointed at.
 */
export async function connectionParents(connectionId: string): Promise<
	{ ref: string; name: string; detail: string | null }[]
> {
	const connection = dbClientConnectionQueries.get(connectionId);
	if (!connection) throw new Error('db-client connection not found');

	if (connection.driver === 'sqlite') {
		const file = connection.database ?? '';
		return file ? [{ ref: file, name: path.basename(file), detail: file }] : [];
	}

	if (connection.driver === 'redis') {
		return Array.from({ length: REDIS_DATABASES }, (_, index) => ({
			ref: String(index),
			name: `Database ${index}`,
			detail: null
		}));
	}

	try {
		const names = await listDatabaseNames(connectionId);
		const usable = names.filter((name) => !isClopenDatabaseName(name));
		if (usable.length > 0) {
			return usable.map((name) => ({ ref: name, name, detail: null }));
		}
	} catch (error) {
		debug.warn('worktree', `Could not list databases on ${connection.name}: ${messageOf(error)}`);
	}

	// Falling back to the one the connection names beats an empty picker: it is
	// the database the user chose when they made the connection.
	return connection.database
		? [{ ref: connection.database, name: connection.database, detail: null }]
		: [];
}

/* --------------------------------------------------------------- projection */

/**
 * Give a connection-sourced copy its own DB Client row.
 *
 * The account projector cannot do this one: it runs per integration account,
 * and a copy of a local Postgres has none. Written here directly instead, so
 * that being able to INSPECT a worktree's database does not depend on where the
 * database came from — which was the point of the whole refactor.
 */
export function projectConnectionBranch(row: WorktreeBranchRow, worktreeName: string): void {
	if (row.source_kind !== 'connection') return;
	const parent = row.source_connection_id
		? dbClientConnectionQueries.get(row.source_connection_id)
		: null;
	const connection = worktreeBranchQueries.connectionOf(row);
	if (!parent || !connection) return;

	const fields = {
		driver: parent.driver,
		host: parent.host ?? undefined,
		port: parent.port ?? undefined,
		username: parent.username ?? undefined,
		database: connection.database,
		sslMode: parent.sslMode,
		options: {
			...parent.options,
			worktreeBranch: { branchId: row.id, worktreeId: row.worktree_id }
		}
	};
	const name = `${worktreeName} (${nounFor(parent.driver)})`;

	const existing = row.connection_id ? dbClientConnectionQueries.get(row.connection_id) : null;
	if (existing) {
		dbClientConnectionQueries.update(existing.id, { name, ...fields });
		dbClientConnectionQueries.replacePassword(existing.id, connection.password || null);
		return;
	}

	const created = dbClientConnectionQueries.create({
		name,
		password: connection.password,
		...fields
	});
	worktreeBranchQueries.setConnectionId(row.id, created.id);
}

/** Take that row away again. Silent when there was never one. */
export function releaseConnectionBranch(row: WorktreeBranchRow): void {
	if (row.source_kind !== 'connection' || !row.connection_id) return;
	dbClientConnectionQueries.delete(row.connection_id);
	worktreeBranchQueries.setConnectionId(row.id, null);
}
