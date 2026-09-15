/**
 * Worktree database branching — shared vocabulary.
 *
 * The worktree manager talks about a BRANCH DATABASE, not about Neon. Every
 * provider that can offer the `worktree-branching` capability is normalised
 * into these shapes by an adapter, and the manager never learns which one
 * answered — the same test `Task 2` and `Task 3` set for their surfaces: if
 * Turso needs a second dialog, these types are wrong and fixing them is the
 * work.
 *
 * The word "branch" is deliberately NOT baked into the copy. Neon cuts a real
 * copy-on-write branch; Turso seeds a whole new database from a parent. Both
 * are "an isolated database derived from a parent", and `BranchProviderInfo`
 * carries the noun each provider uses so the dialog can say what actually
 * happens rather than calling a seeded database a branch.
 *
 * Nothing here carries a credential. The connection string a branch answers on
 * is resolved on the server, sealed on the branch row, and written into the
 * worktree's environment — it never crosses this line.
 */

import type { DbDriver, DbSslMode } from './db-client';

/**
 * Where a worktree's database comes from.
 *
 * `account` is a provider that branches natively — Neon cuts a copy-on-write
 * branch through its API. `connection` is everything else: a database Clopen
 * can already reach, copied with that engine's own primitives. The second is
 * the general case and the first is the optimisation, which is the opposite of
 * how this feature started.
 */
export type BranchSourceKind = 'account' | 'connection';

/** How much of the parent a worktree's database starts with. */
export type BranchDataMode = 'schema-data' | 'schema' | 'empty';

/**
 * A place worktree databases can come from, as the setup dialog lists them.
 *
 * Accounts and connections are one list rather than two tabs: the user is
 * choosing WHICH DATABASE, and whether the copy happens through a vendor API or
 * through `CREATE DATABASE` is an implementation detail they should be told
 * about, not asked to navigate.
 */
export interface BranchSourceOption {
	kind: BranchSourceKind;
	/** The account id, or the DB Client connection id. */
	id: string;
	label: string;
	/** Integration provider id for an account, driver id for a connection. */
	provider: string;
	providerName: string;
	/** What this source calls one — "branch" for Neon, "copy" for the rest. */
	noun: string;
	/** True when the provider branches natively rather than Clopen copying. */
	isNative: boolean;
	/** One sentence naming what a copy here does not carry, or null. */
	notice: string | null;
	/** Health, for the same strip the accounts list uses. */
	status: string;
}

/** A parent database a worktree's branch is cut from. */
export interface BranchParent {
	/** The provider's own id for the parent — a Neon project id. */
	ref: string;
	name: string;
	/** Region, plan — whatever tells two similarly named parents apart. */
	detail: string | null;
	/** The owning container's name, so which organisation is billed is visible. */
	group: string | null;
	/** Whether a branch can be cut from it right now. The ADAPTER decides. */
	isReady: boolean;
}

/** Where a created branch answers. The password is server-side only. */
export interface BranchConnection {
	/** The full URI, which is what lands in the worktree's environment. */
	uri: string;
	host: string;
	port: number;
	username: string;
	password: string;
	database: string;
	sslMode: DbSslMode;
}

/** What an adapter hands back after cutting one. */
export interface CreatedBranch {
	/** The provider's own id for the branch. */
	ref: string;
	/** The name it was actually given, which may differ from the one requested. */
	name: string;
	connection: BranchConnection;
}

/** A branch as it exists at the provider, for the orphan sweep. */
export interface RemoteBranch {
	ref: string;
	name: string;
	createdAt: string | null;
	/** A provider's default branch is never ours and is never offered for delete. */
	isDefault: boolean;
	/** Logical size in bytes, when the provider reports one. */
	sizeBytes: number | null;
}

/** A branching provider as the setup dialog renders it. */
export interface BranchProviderInfo {
	/** Matches the integration provider id, so the brand mark is the same one. */
	id: string;
	name: string;
	/**
	 * What this provider calls one, singular and lowercase — "branch" for Neon,
	 * "database" for Turso. Used in copy so a seeded Turso database is never
	 * described as a branch.
	 */
	noun: string;
	/** What the parent is called — "Neon project". */
	parentLabel: string;
	description: string;
	/** One sentence naming what cutting one actually costs. */
	notice: string;
	/** True when the provider can hand back a pooled endpoint as well. */
	supportsPooled: boolean;
}

/**
 * Per-project settings for branching.
 *
 * `envFile` has NO default worth guessing, which is why it is asked for at
 * setup. Next.js and Vite read `.env.local` in PREFERENCE to `.env`, so writing
 * the wrong one produces the worst possible outcome: the branch is created, the
 * variable is written, and nothing reads it.
 */
export interface WorktreeBranchConfig {
	/** The variable the connection URI is written to. */
	envVar: string;
	/** Which dotenv file inside the worktree receives the managed block. */
	envFile: string;
	/** Offer it, ticked, on every worktree create. */
	autoCreate: boolean;
	/** Ask the provider for a pooled endpoint instead of a direct one. */
	pooled: boolean;
	/**
	 * How much of the parent a new worktree's database starts with.
	 *
	 * Remembered per project and overridable per worktree, because the right
	 * answer depends on the database rather than on the feature: a seeded dev
	 * database is worth copying whole, and a forty-gigabyte one is not.
	 */
	dataMode: BranchDataMode;
}

export const DEFAULT_WORKTREE_BRANCH_CONFIG: WorktreeBranchConfig = {
	envVar: 'DATABASE_URL',
	envFile: '.env',
	autoCreate: true,
	// Direct, not pooled, and the default is not a question to ask. A worktree is
	// where an agent runs migrations: a transaction-mode pooler breaks prepared
	// statements and some DDL, and the failure arrives as a confusing driver
	// error rather than as a configuration one.
	pooled: false,
	// Copying the data is what makes a worktree feel like the project rather
	// than like an empty shell of it — the app starts, the fixtures are there,
	// and an agent can actually run what it just changed.
	dataMode: 'schema-data'
};

/** The binding for one project, as the worktree manager sees it. */
export interface WorktreeBranchBindingInfo {
	projectId: string;
	sourceKind: BranchSourceKind;
	/** The account id, or the DB Client connection id. */
	sourceId: string;
	provider: string;
	providerName: string;
	/** The account's label, or the connection's name. */
	sourceLabel: string;
	parentRef: string;
	parentName: string;
	isNative: boolean;
	config: WorktreeBranchConfig;
	updatedAt: string;
}

/**
 * What happened when the connection string was written into the worktree.
 *
 * `skipped-tracked` is the one that matters. A dotenv file that git TRACKS
 * would be carried back to the main project by "Apply to Main", overwriting the
 * real connection string with one that points at a database this worktree's
 * deletion destroys. So it is refused rather than written, and the refusal is
 * reported instead of being logged and forgotten.
 */
export type BranchEnvStatus = 'written' | 'skipped-tracked' | 'failed';

/** A live or orphaned branch, as the manager sees it. */
export interface WorktreeBranchInfo {
	id: string;
	/** Null once the worktree is gone — which is what makes a row an orphan. */
	worktreeId: string | null;
	worktreeName: string | null;
	sourceKind: BranchSourceKind;
	provider: string;
	providerName: string;
	/** What this source calls one, so copy reads right per source. */
	noun: string;
	/** The account id, or the DB Client connection id. */
	sourceId: string;
	sourceLabel: string;
	/** Which mechanism made it — `template`, `row-copy`, `file-copy`, … */
	strategy: string | null;
	/** One sentence naming what the copy did not carry, or null. */
	notice: string | null;
	parentRef: string;
	branchRef: string;
	branchName: string;
	envVar: string;
	envFile: string;
	envStatus: BranchEnvStatus;
	envDetail: string | null;
	status: 'active' | 'orphaned';
	/** Why it is orphaned — the provider's own words for the failed delete. */
	error: string | null;
	/** The projected DB Client connection, so the branch can be inspected. */
	connectionId: string | null;
	createdAt: string;
}

/**
 * A branch at the provider that Clopen has no row for.
 *
 * The second half of orphan detection. A crash between "the provider created
 * it" and "the row was written" leaves a branch nothing here knows about, and
 * the only thing tying it back is the name — which is why branch names are
 * deterministic and prefixed.
 */
export interface UnknownRemoteBranch {
	sourceKind: BranchSourceKind;
	/** The account id, or the DB Client connection id. */
	sourceId: string;
	provider: string;
	parentRef: string;
	branch: RemoteBranch;
}

/** Everything the worktree manager's branching dialog renders. */
export interface WorktreeBranchingState {
	providers: BranchProviderInfo[];
	/**
	 * Everywhere a worktree database could come from — accounts AND connections.
	 *
	 * One list, because "which database" is one question. See
	 * `BranchSourceOption`.
	 */
	sources: BranchSourceOption[];
	binding: WorktreeBranchBindingInfo | null;
	/** Dotenv files that already exist in the project, most-precedent first. */
	envFiles: string[];
	branches: WorktreeBranchInfo[];
}

/** The result of attaching a branch to a freshly created worktree. */
export interface BranchAttachResult {
	branch: WorktreeBranchInfo | null;
	/** What the copy did not carry, when it carried less than everything. */
	notice?: string | null;
	/**
	 * Why no branch was attached, when one was expected.
	 *
	 * Fail-soft is the rule: a provider outage must never cost the user the
	 * worktree they asked for, so this is reported alongside a worktree that was
	 * created successfully rather than thrown.
	 */
	error: string | null;
}

/** The branch-name prefix every source-side name carries. */
export const BRANCH_NAME_PREFIX = 'clopen';

/**
 * The binding a project would get if it asked for one.
 *
 * Derived from the project's own `.env` and Clopen's connection list, so the
 * dialog can offer "also give it its own database" without the user having
 * configured anything first. Null when the URL in the project's environment
 * corresponds to no saved connection — Clopen would have the address but not
 * the password, and an offer that fails at the moment of use is worse than no
 * offer.
 */
export interface BranchSuggestion {
	sourceKind: 'connection';
	sourceId: string;
	sourceLabel: string;
	providerName: string;
	/** The database to copy — a name, or a file path for SQLite. */
	parentRef: string;
	parentName: string;
	/** The variable the copy's URL should be written to. */
	envVar: string;
	/** Which dotenv file that variable already lives in. */
	envFile: string;
	/** What a copy here does not carry, or null. */
	notice: string | null;
}

/** A database on a connection that a worktree copy could be made from. */
export interface BranchConnectionParent {
	/** The database name, its file path for SQLite, its index for Redis. */
	ref: string;
	name: string;
	driver: DbDriver;
}
