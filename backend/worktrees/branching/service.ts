/**
 * Worktree databases — the lifecycle, the binding, and the leaks.
 *
 * FAIL SOFT IS THE RULE, and it is not a nicety. Creating a worktree is the
 * expensive, visible thing the user asked for; giving it its own database is a
 * convenience layered on top. A provider outage, an expired key, a branch
 * limit, a `CREATE DATABASE` the server refuses — all must cost the convenience
 * and never the worktree. So nothing in `attach()` throws, and what went wrong
 * is reported alongside a worktree that was created successfully.
 *
 * The other half is the mirror image: deleting a worktree deletes its database,
 * and when THAT fails the deletion still goes ahead. Refusing to delete a
 * worktree because a third party is down would trap the user in a state they
 * cannot leave. What the failure earns instead is a row that outlives its
 * worktree and an entry in the orphan list, because a database that nothing
 * knows about is the one outcome this feature must never produce silently.
 *
 * WHERE THE DATABASE COMES FROM is `engine.ts`'s question, not this file's.
 * Everything here works the same whether Neon cut a copy-on-write branch or
 * Clopen ran `CREATE DATABASE … TEMPLATE` against a Postgres on the user's
 * laptop.
 */

import {
	integrationAccountQueries,
	projectQueries,
	worktreeBranchBindingQueries,
	worktreeBranchQueries,
	worktreeQueries,
	parseWorktreeBranchConfig,
	type WorktreeBranchRow
} from '$backend/database/queries';
import { reproject } from '$backend/integrations';
import { listDotenvFiles, writeWorktreeEnv } from '$backend/env-files';
import type { Worktree } from '$shared/types/database/schema';
import type {
	BranchAttachResult,
	BranchDataMode,
	BranchParent,
	BranchSourceKind,
	BranchSourceOption,
	UnknownRemoteBranch,
	WorktreeBranchBindingInfo,
	WorktreeBranchConfig,
	WorktreeBranchInfo,
	WorktreeBranchingState
} from '$shared/types/worktree-branching';
import { DEFAULT_WORKTREE_BRANCH_CONFIG } from '$shared/types/worktree-branching';
import { isSafeEnvFileName } from '$backend/env-files';
import { getBranchProvider, listBranchProviders } from './registry';
import { branchNameFor, isClopenBranchName } from './naming';
import {
	connectionParents,
	listBranchSources,
	projectConnectionBranch,
	releaseConnectionBranch,
	resolveEngine,
	resolveEngineForBranch,
	type BranchEngine,
	type BranchPrincipal
} from './engine';
import { suggestBranchSource, type BranchSuggestion } from './suggest';
import { debug } from '$shared/utils/logger';

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The source, if this caller may use it.
 *
 * The authorisation for the whole feature, in one place. `listBranchSources`
 * already answers "what may they use", so asking it rather than re-deriving the
 * rule is what stops the two from drifting — and an id that is not in the list
 * is refused with the same sentence whether it is someone else's connection or
 * an account a member cannot reach.
 */
function requireSource(
	input: { sourceKind: BranchSourceKind; sourceId: string },
	principal: BranchPrincipal
): BranchSourceOption {
	const source = listBranchSources(principal).find(
		(entry) => entry.kind === input.sourceKind && entry.id === input.sourceId
	);
	if (!source) {
		throw new Error('That database source is not available to you, so nothing was saved.');
	}
	return source;
}

/** The engine for one project, plus the settings it was bound with. */
function resolveBinding(projectId: string):
	| { ok: true; engine: BranchEngine; config: WorktreeBranchConfig }
	| { ok: false; reason: string | null } {
	const binding = worktreeBranchBindingQueries.get(projectId);
	const resolved = resolveEngine(binding);
	if (!resolved.ok) return resolved;
	return {
		ok: true,
		engine: resolved.engine,
		config: parseWorktreeBranchConfig(binding!.config_json)
	};
}

/**
 * Project a freshly created or deleted branch into DB Client.
 *
 * Two routes because there are two ownerships. An account's branches are
 * projected by the integrations layer, which owns the account's whole
 * projection set; a connection's copy has no account, so its row is written
 * directly. Being able to INSPECT a worktree's database must not depend on
 * where the database came from.
 */
function syncProjection(row: WorktreeBranchRow): void {
	if (row.source_kind === 'account' && row.account_id) {
		reproject(row.account_id);
		return;
	}
	const worktree = row.worktree_id ? worktreeQueries.getById(row.worktree_id) : null;
	if (worktree) projectConnectionBranch(row, worktree.name);
	else releaseConnectionBranch(row);
}

function toBranchInfo(row: WorktreeBranchRow): WorktreeBranchInfo {
	const engine = resolveEngineForBranch(row);
	const worktree = row.worktree_id ? worktreeQueries.getById(row.worktree_id) : null;
	const account = row.account_id ? integrationAccountQueries.getById(row.account_id) : null;

	return {
		id: row.id,
		worktreeId: row.worktree_id,
		worktreeName: worktree?.name ?? null,
		sourceKind: row.source_kind,
		provider: engine?.provider ?? account?.provider ?? 'unknown',
		providerName: engine?.providerName ?? 'Unknown',
		noun: engine?.noun ?? 'database',
		sourceId: row.account_id ?? row.source_connection_id ?? '',
		sourceLabel:
			engine?.sourceLabel ??
			(row.source_kind === 'account' ? 'Disconnected account' : 'Deleted connection'),
		strategy: row.strategy,
		notice: row.notice,
		parentRef: row.parent_ref,
		branchRef: row.branch_ref,
		branchName: row.branch_name,
		envVar: row.env_var,
		envFile: row.env_file,
		envStatus: row.env_status,
		envDetail: row.env_detail,
		status: row.status,
		error: row.error,
		connectionId: row.connection_id,
		createdAt: row.created_at
	};
}

export const worktreeBranching = {
	/**
	 * Give a freshly created worktree a database of its own.
	 *
	 * Called from `createWorktree` AFTER the clone has succeeded, and the order
	 * matters: the clone is the expensive step that genuinely fails, so making
	 * the database first would leak one on every failed create.
	 *
	 * The row is written BEFORE the dotenv file is touched. A crash in between
	 * leaves a database that is tracked, listed and deletable; the reverse
	 * ordering leaves one that only the orphan sweep could ever find.
	 */
	async attach(
		worktree: Worktree,
		options: { skip?: boolean; dataMode?: BranchDataMode } = {}
	): Promise<BranchAttachResult> {
		const resolved = resolveBinding(worktree.project_id);
		if (!resolved.ok) return { branch: null, error: resolved.reason };

		// Three states, not two. `skip` is what the New Worktree dialog answered
		// and it wins outright; UNDEFINED is a caller that never asked — Start
		// Work creates a worktree with no dialog at all — and for those the
		// project's own default decides, exactly as before.
		if (options.skip === true) return { branch: null, error: null };
		if (options.skip === undefined && !resolved.config.autoCreate) {
			return { branch: null, error: null };
		}

		const project = projectQueries.getById(worktree.project_id);
		const projectName = project?.name ?? worktree.project_id;
		const name = branchNameFor({ projectName, worktreeSlug: worktree.slug });
		const engine = resolved.engine;

		let row: WorktreeBranchRow;
		try {
			const created = await engine.create({
				name,
				projectName,
				worktreeSlug: worktree.slug,
				pooled: resolved.config.pooled,
				// The dialog's per-worktree answer wins over the project's default,
				// because the size of THIS database is what the user just looked at.
				dataMode: options.dataMode ?? resolved.config.dataMode
			});

			row = worktreeBranchQueries.create({
				worktreeId: worktree.id,
				projectId: worktree.project_id,
				sourceKind: engine.sourceKind,
				sourceId: engine.sourceId,
				parentRef: engine.parentRef,
				branchRef: created.ref,
				branchName: created.name,
				connection: created.connection,
				envVar: resolved.config.envVar,
				envFile: resolved.config.envFile,
				strategy: created.strategy,
				notice: created.notice
			});
		} catch (error) {
			debug.warn('worktree', `Could not give ${worktree.name} its own database: ${messageOf(error)}`);
			return { branch: null, error: messageOf(error) };
		}

		const connection = worktreeBranchQueries.connectionOf(row);
		const written = await writeWorktreeEnv({
			worktreeRoot: worktree.path,
			fileName: resolved.config.envFile,
			vars: { [resolved.config.envVar]: connection?.uri ?? '' },
			// Only ever seen when the worktree's dotenv file did not already have
			// the key, so it explains a line that would otherwise appear from
			// nowhere. A file that DID have it gets the replacement plus the
			// `# clopen:previous` comment, which says the same thing better.
			note: `${engine.noun} of ${engine.parentName}, created by Clopen for this worktree.`
		});
		worktreeBranchQueries.setEnvResult(row.id, written.status, written.detail);

		syncProjection(worktreeBranchQueries.getById(row.id)!);

		const final = worktreeBranchQueries.getById(row.id);
		return {
			branch: final ? toBranchInfo(final) : null,
			error: null,
			notice: row.notice
		};
	},

	/**
	 * Delete the database a worktree owns.
	 *
	 * Called from `removeWorktree` BEFORE the directory and the row go, so the
	 * database is still reachable through its own row. Never throws: the caller
	 * is mid-deletion and the user has already said what they want.
	 */
	async detach(worktreeId: string): Promise<void> {
		const row = worktreeBranchQueries.getForWorktree(worktreeId);
		if (!row) return;

		const engine = resolveEngineForBranch(row);
		if (!engine) {
			worktreeBranchQueries.markOrphaned(
				row.id,
				row.source_kind === 'account'
					? 'The account that created it is no longer connected, so it could not be deleted.'
					: 'The connection it was copied from has been deleted, so it could not be removed.'
			);
			debug.warn('worktree', `${row.branch_name} outlived its source and is now an orphan`);
			releaseConnectionBranch(row);
			return;
		}

		// Released BEFORE the delete either way: the projected row points at a
		// database that is about to stop existing, or at one that has stopped
		// belonging to a live worktree. Both are reasons for it to go, and doing
		// it once here avoids a second pass over a row that may no longer exist.
		releaseConnectionBranch(row);

		try {
			await engine.delete(row.branch_ref);
			worktreeBranchQueries.remove(row.id);
			debug.log('worktree', `Deleted ${engine.providerName} ${engine.noun} ${row.branch_name}`);
		} catch (error) {
			// The row SURVIVES, which is the whole point: a database nothing knows
			// about is the one failure this feature must never produce quietly. It
			// keeps its refs and its connection, which is exactly what a retry from
			// the orphan list needs.
			worktreeBranchQueries.markOrphaned(row.id, messageOf(error));
			debug.warn('worktree', `Could not delete ${row.branch_name}: ${messageOf(error)}`);
		}

		if (row.account_id) reproject(row.account_id);
	},

	/** Which database a worktree owns, for the manager's list. */
	forWorktree(worktreeId: string): WorktreeBranchInfo | null {
		const row = worktreeBranchQueries.getForWorktree(worktreeId);
		return row ? toBranchInfo(row) : null;
	},

	/** Every database belonging to one project, live or orphaned. */
	forProject(projectId: string): WorktreeBranchInfo[] {
		return worktreeBranchQueries.getForProject(projectId).map(toBranchInfo);
	},

	/**
	 * Everything the setup dialog renders for one project.
	 *
	 * The dotenv file list is part of it because there is no default worth
	 * guessing: Next.js and Vite read `.env.local` in preference to `.env`, so a
	 * project with both has one right answer and picking the other produces a
	 * database nothing reads.
	 */
	async state(projectId: string, principal: BranchPrincipal): Promise<WorktreeBranchingState> {
		const project = projectQueries.getById(projectId);
		const binding = worktreeBranchBindingQueries.get(projectId);
		const resolved = resolveEngine(binding);
		const engine = resolved.ok ? resolved.engine : null;

		return {
			providers: listBranchProviders().map((adapter) => adapter.info()),
			sources: listBranchSources(principal),
			binding:
				binding && engine
					? {
						projectId: binding.project_id,
						sourceKind: engine.sourceKind,
						sourceId: engine.sourceId,
						provider: engine.provider,
						providerName: engine.providerName,
						sourceLabel: engine.sourceLabel,
						parentRef: binding.parent_ref,
						parentName: binding.parent_name,
						isNative: engine.isNative,
						config: parseWorktreeBranchConfig(binding.config_json),
						updatedAt: binding.updated_at
					}
					: null,
			envFiles: project ? await listDotenvFiles(project.path) : [],
			branches: this.forProject(projectId)
		};
	},

	/**
	 * What this project's worktrees should copy, worked out from its own files.
	 *
	 * Offered only when there is no binding yet: once the user has chosen, a
	 * guess arriving beside their choice would be noise.
	 */
	async suggest(projectId: string): Promise<BranchSuggestion | null> {
		if (worktreeBranchBindingQueries.get(projectId)) return null;
		const project = projectQueries.getById(projectId);
		if (!project) return null;
		return suggestBranchSource(project.path);
	},

	/**
	 * The databases one source can copy from.
	 *
	 * Two shapes behind one route: a provider's own list of projects, or the
	 * databases on a server Clopen already has a connection to.
	 */
	async parents(
		input: { sourceKind: BranchSourceKind; sourceId: string },
		principal: BranchPrincipal
	): Promise<BranchParent[]> {
		requireSource(input, principal);
		if (input.sourceKind === 'connection') {
			const parents = await connectionParents(input.sourceId);
			return parents.map((parent) => ({
				ref: parent.ref,
				name: parent.name,
				detail: parent.detail,
				group: null,
				isReady: true
			}));
		}

		const account = integrationAccountQueries.getById(input.sourceId);
		if (!account) throw new Error('Integration account not found');
		const adapter = getBranchProvider(account.provider);
		if (!adapter) throw new Error(`"${account.provider}" cannot create database branches`);
		return adapter.listParents({
			accountId: account.id,
			credentials: integrationAccountQueries.credentialsOf(account)
		});
	},

	/**
	 * Point a project at a parent database.
	 *
	 * The env file is validated HERE rather than at write time, because a name
	 * this refuses would otherwise be accepted by the form and then fail once
	 * per worktree, far away from the field that caused it.
	 */
	saveBinding(
		input: {
			projectId: string;
			sourceKind: BranchSourceKind;
			sourceId: string;
			parentRef: string;
			parentName: string;
			config: Partial<WorktreeBranchConfig>;
		},
		principal: BranchPrincipal
	): WorktreeBranchBindingInfo {
		const source = requireSource(input, principal);

		const config: WorktreeBranchConfig = {
			...DEFAULT_WORKTREE_BRANCH_CONFIG,
			...input.config,
			envVar: (input.config.envVar ?? DEFAULT_WORKTREE_BRANCH_CONFIG.envVar).trim(),
			envFile: (input.config.envFile ?? DEFAULT_WORKTREE_BRANCH_CONFIG.envFile).trim()
		};

		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.envVar)) {
			throw new Error(`"${config.envVar}" is not a valid environment variable name.`);
		}
		if (!isSafeEnvFileName(config.envFile)) {
			throw new Error(`"${config.envFile}" is not a dotenv file in the project root.`);
		}

		worktreeBranchBindingQueries.upsert({
			projectId: input.projectId,
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			parentRef: input.parentRef,
			parentName: input.parentName.trim() || input.parentRef,
			config
		});

		return {
			projectId: input.projectId,
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			provider: source.provider,
			providerName: source.providerName,
			sourceLabel: source.label,
			parentRef: input.parentRef,
			parentName: input.parentName.trim() || input.parentRef,
			isNative: source.isNative,
			config,
			updatedAt: new Date().toISOString()
		};
	},

	/**
	 * Stop giving this project's worktrees their own database.
	 *
	 * Existing ones are LEFT ALONE. Removing the binding says "no more", not
	 * "destroy the ones my worktrees are using" — and the worktrees using them
	 * are still open. They go when their worktrees do, exactly as before.
	 */
	clearBinding(projectId: string): void {
		worktreeBranchBindingQueries.remove(projectId);
	},

	/** Every tracked database with no live worktree behind it. */
	orphans(): WorktreeBranchInfo[] {
		return worktreeBranchQueries.orphans().map(toBranchInfo);
	},

	/**
	 * Delete an orphan at its source and drop its row.
	 *
	 * The remote call goes FIRST here, which is the opposite of `dbLinks.remove`
	 * and for the opposite reason: there, a failed delete cost a link that could
	 * be recreated. Here the row IS the only record of a real database, so
	 * dropping it before the delete succeeded would turn a reportable orphan into
	 * an invisible one.
	 */
	async deleteOrphan(branchId: string): Promise<void> {
		const row = worktreeBranchQueries.getById(branchId);
		if (!row) return;

		const engine = resolveEngineForBranch(row);
		if (!engine) {
			throw new Error(
				row.source_kind === 'account'
					? 'The account that created it is no longer connected, so it cannot be deleted from here.'
					: 'The connection it was copied from has been deleted, so it cannot be removed from here.'
			);
		}

		await engine.delete(row.branch_ref);
		releaseConnectionBranch(row);
		worktreeBranchQueries.remove(row.id);
		if (row.account_id) reproject(row.account_id);
		debug.log('worktree', `Deleted orphaned ${engine.noun} ${row.branch_name}`);
	},

	/**
	 * Drop the row and leave the database alone.
	 *
	 * Offered because Clopen is not the only place a database can be deleted:
	 * someone who cleaned it up in Neon's console or with `dropdb` is otherwise
	 * stuck with a permanent orphan entry whose delete fails with an error they
	 * cannot act on.
	 */
	forgetOrphan(branchId: string): void {
		const row = worktreeBranchQueries.getById(branchId);
		if (!row) return;
		releaseConnectionBranch(row);
		worktreeBranchQueries.remove(row.id);
		if (row.account_id) reproject(row.account_id);
	},

	/**
	 * Databases at the source that no row here accounts for.
	 *
	 * The half of leak detection a local table cannot do. A crash between "the
	 * database was created" and "the row was written" leaves one that nothing
	 * knows about, and the deterministic `clopen` prefix is the only evidence
	 * tying it back — which is exactly why `naming.ts` makes it deterministic.
	 *
	 * Reports only. Something that merely LOOKS like ours — someone could have
	 * named a database `clopen_…` by hand — is offered for deletion and never
	 * deleted automatically.
	 */
	async unknownBranches(projectId: string): Promise<UnknownRemoteBranch[]> {
		const resolved = resolveBinding(projectId);
		if (!resolved.ok) return [];
		const engine = resolved.engine;

		// Keyed on the SOURCE, not the project. One Postgres server can hold the
		// copies of several projects, and a set built from this project's rows
		// would report every other project's database as a leak — and offer it for
		// deletion.
		const known = new Set(
			(engine.sourceKind === 'account'
				? worktreeBranchQueries.getForAccount(engine.sourceId)
				: worktreeBranchQueries.getForSourceConnection(engine.sourceId)
			)
				.filter((row) => row.parent_ref === engine.parentRef)
				.map((row) => row.branch_ref)
		);

		let branches;
		try {
			branches = await engine.list();
		} catch (error) {
			// A sweep that cannot reach the source reports nothing rather than
			// reporting "no orphans" — which would be a claim it never verified.
			throw new Error(`Could not list databases on ${engine.sourceLabel}: ${messageOf(error)}`);
		}

		return branches
			.filter((branch) => !known.has(branch.ref))
			.map((branch) => ({
				sourceKind: engine.sourceKind,
				sourceId: engine.sourceId,
				provider: engine.provider,
				parentRef: engine.parentRef,
				branch
			}));
	},

	/** Delete something the sweep found but no row tracks. */
	async deleteUnknown(input: {
		sourceKind: BranchSourceKind;
		sourceId: string;
		parentRef: string;
		branchRef: string;
	}): Promise<void> {
		const resolved = resolveEngine({
			project_id: '',
			source_kind: input.sourceKind,
			account_id: input.sourceKind === 'account' ? input.sourceId : null,
			connection_id: input.sourceKind === 'connection' ? input.sourceId : null,
			parent_ref: input.parentRef,
			parent_name: input.parentRef,
			config_json: '{}',
			created_at: '',
			updated_at: ''
		});
		if (!resolved.ok) throw new Error(resolved.reason ?? 'That source is no longer available.');

		await resolved.engine.delete(input.branchRef);
		debug.log('worktree', `Deleted untracked database ${input.branchRef}`);
	},

	/**
	 * Put the connection string back into a worktree's dotenv file.
	 *
	 * The retry for `skipped-tracked` and `failed`, and the reason it is a button
	 * rather than an automatic repeat: the fix for a tracked file is a change to
	 * `.gitignore` that only the user can make, and retrying on a timer would
	 * just re-report the same refusal.
	 */
	async rewriteEnv(branchId: string): Promise<WorktreeBranchInfo | null> {
		const row = worktreeBranchQueries.getById(branchId);
		if (!row?.worktree_id) return null;

		const worktree = worktreeQueries.getById(row.worktree_id);
		const connection = worktreeBranchQueries.connectionOf(row);
		if (!worktree || !connection) return toBranchInfo(row);

		const engine = resolveEngineForBranch(row);
		const written = await writeWorktreeEnv({
			worktreeRoot: worktree.path,
			fileName: row.env_file,
			vars: { [row.env_var]: connection.uri },
			note: `${engine?.noun ?? 'database'} of ${row.parent_ref}, created by Clopen for this worktree.`
		});
		worktreeBranchQueries.setEnvResult(row.id, written.status, written.detail);

		return toBranchInfo(worktreeBranchQueries.getById(row.id)!);
	},

	/** Health for the hub, delegated to whichever adapter owns the provider. */
	async probe(accountId: string) {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) return null;
		const adapter = getBranchProvider(account.provider);
		if (!adapter) return null;
		if (!integrationAccountQueries.capabilitiesOf(account).includes('worktree-branching')) return null;
		return adapter.probe({
			accountId: account.id,
			credentials: integrationAccountQueries.credentialsOf(account)
		});
	}
};

/** Re-exported so the worktree manager can still recognise our own names. */
export { isClopenBranchName };
