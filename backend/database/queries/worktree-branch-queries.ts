/**
 * Worktree database branching — the binding, and the branches it produced.
 *
 * The binding table holds no secret: a parent ref and four display settings.
 * The branch table holds a whole connection string, password included, so
 * `connection_json` is sealed at rest by the crypto layer — callers here hand in
 * and receive a plain object and never see an envelope.
 *
 * A blob the active key cannot open reads as `null`, which every caller treats
 * exactly as it treats a branch whose connection was never resolved: the branch
 * is still listed, still deletable at the provider, and simply projects no
 * connection. Throwing instead would take down the worktree list itself.
 */

import { getDatabase } from '../index';
import { openRow, openRows, sealFor } from '../crypto';
import type {
	BranchConnection,
	BranchEnvStatus,
	BranchSourceKind,
	WorktreeBranchConfig
} from '$shared/types/worktree-branching';
import { DEFAULT_WORKTREE_BRANCH_CONFIG } from '$shared/types/worktree-branching';

const BRANCH_TABLE = 'worktree_branches';

export interface WorktreeBranchBindingRow {
	project_id: string;
	source_kind: BranchSourceKind;
	/** Set for an account source, null for a connection one. */
	account_id: string | null;
	/** Set for a connection source, null for an account one. */
	connection_id: string | null;
	parent_ref: string;
	parent_name: string;
	config_json: string;
	created_at: string;
	updated_at: string;
}

export interface WorktreeBranchRow {
	id: string;
	/** Null once the worktree is gone. That is what makes the row an orphan. */
	worktree_id: string | null;
	project_id: string;
	source_kind: BranchSourceKind;
	account_id: string | null;
	/** The DB Client connection copied FROM. No FK — see migration 078. */
	source_connection_id: string | null;
	parent_ref: string;
	branch_ref: string;
	branch_name: string;
	/** Sealed on disk, plain JSON string here. Null when the key could not open it. */
	connection_json: string | null;
	connection_id: string | null;
	env_var: string;
	env_file: string;
	env_status: BranchEnvStatus;
	env_detail: string | null;
	status: 'active' | 'orphaned';
	error: string | null;
	/** Which mechanism made it, for the sentence the manager shows. */
	strategy: string | null;
	/** What that mechanism did not carry, or null. */
	notice: string | null;
	created_at: string;
	updated_at: string;
}

/** The account or connection a row belongs to, whichever it is. */
export function sourceIdOf(row: { account_id: string | null; connection_id?: string | null; source_connection_id?: string | null }): string {
	return row.account_id ?? row.source_connection_id ?? row.connection_id ?? '';
}

/**
 * Parse the stored config over the defaults.
 *
 * Merged rather than replaced, for the reason `parseDeployConfig` merges: a
 * config written before an option existed must not read back with that option
 * `undefined`. Here that would be worse than a wrong filter — an `envVar` of
 * `undefined` writes the literal string "undefined=" into someone's dotenv file.
 */
export function parseWorktreeBranchConfig(raw: string | null): WorktreeBranchConfig {
	if (!raw) return { ...DEFAULT_WORKTREE_BRANCH_CONFIG };
	try {
		const parsed = JSON.parse(raw) as Partial<WorktreeBranchConfig> | null;
		return { ...DEFAULT_WORKTREE_BRANCH_CONFIG, ...(parsed ?? {}) };
	} catch {
		return { ...DEFAULT_WORKTREE_BRANCH_CONFIG };
	}
}

export const worktreeBranchBindingQueries = {
	get(projectId: string): WorktreeBranchBindingRow | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM worktree_branch_bindings WHERE project_id = ?`
		).get(projectId) as WorktreeBranchBindingRow | null;
	},

	getForAccount(accountId: string): WorktreeBranchBindingRow[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM worktree_branch_bindings WHERE account_id = ?`
		).all(accountId) as WorktreeBranchBindingRow[];
	},

	upsert(input: {
		projectId: string;
		sourceKind: BranchSourceKind;
		sourceId: string;
		parentRef: string;
		parentName: string;
		config: WorktreeBranchConfig;
	}): WorktreeBranchBindingRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		const existing = this.get(input.projectId);
		const accountId = input.sourceKind === 'account' ? input.sourceId : null;
		const connectionId = input.sourceKind === 'connection' ? input.sourceId : null;

		db.prepare(`
			INSERT INTO worktree_branch_bindings (
				project_id, source_kind, account_id, connection_id,
				parent_ref, parent_name, config_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project_id) DO UPDATE SET
				source_kind   = excluded.source_kind,
				account_id    = excluded.account_id,
				connection_id = excluded.connection_id,
				parent_ref    = excluded.parent_ref,
				parent_name   = excluded.parent_name,
				config_json   = excluded.config_json,
				updated_at    = excluded.updated_at
		`).run(
			input.projectId,
			input.sourceKind,
			accountId,
			connectionId,
			input.parentRef,
			input.parentName,
			JSON.stringify(input.config),
			existing?.created_at ?? now,
			now
		);

		return this.get(input.projectId)!;
	},

	remove(projectId: string): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM worktree_branch_bindings WHERE project_id = ?`).run(projectId);
	}
};

function openBranch<T extends WorktreeBranchRow | null>(row: T): T {
	return (row ? openRow(BRANCH_TABLE, row) : row) as T;
}

export const worktreeBranchQueries = {
	getById(id: string): WorktreeBranchRow | null {
		const db = getDatabase();
		return openBranch(
			db.prepare(`SELECT * FROM worktree_branches WHERE id = ?`).get(id) as WorktreeBranchRow | null
		);
	},

	/** The branch attached to one worktree, or null when it has none. */
	getForWorktree(worktreeId: string): WorktreeBranchRow | null {
		const db = getDatabase();
		return openBranch(
			db.prepare(
				`SELECT * FROM worktree_branches WHERE worktree_id = ? AND status = 'active'`
			).get(worktreeId) as WorktreeBranchRow | null
		);
	},

	getForAccount(accountId: string): WorktreeBranchRow[] {
		const db = getDatabase();
		return openRows(
			BRANCH_TABLE,
			db.prepare(
				`SELECT * FROM worktree_branches WHERE account_id = ? ORDER BY created_at DESC`
			).all(accountId) as WorktreeBranchRow[]
		);
	},

	getForProject(projectId: string): WorktreeBranchRow[] {
		const db = getDatabase();
		return openRows(
			BRANCH_TABLE,
			db.prepare(
				`SELECT * FROM worktree_branches WHERE project_id = ? ORDER BY created_at DESC`
			).all(projectId) as WorktreeBranchRow[]
		);
	},

	/**
	 * Every branch whose worktree is gone, or whose remote delete failed.
	 *
	 * The two are one query because they are one problem: a branch that still
	 * exists at the provider and is no longer attached to anything. Reporting
	 * them separately would ask the user to understand how each one got that way
	 * before they could act on either.
	 */
	orphans(): WorktreeBranchRow[] {
		const db = getDatabase();
		return openRows(
			BRANCH_TABLE,
			db.prepare(`
				SELECT * FROM worktree_branches
				WHERE worktree_id IS NULL OR status = 'orphaned'
				ORDER BY created_at DESC
			`).all() as WorktreeBranchRow[]
		);
	},

	connectionOf(row: WorktreeBranchRow): BranchConnection | null {
		if (!row.connection_json) return null;
		try {
			const parsed = JSON.parse(row.connection_json) as BranchConnection | null;
			return parsed && typeof parsed.uri === 'string' && parsed.uri ? parsed : null;
		} catch {
			return null;
		}
	},

	create(input: {
		worktreeId: string;
		projectId: string;
		sourceKind: BranchSourceKind;
		sourceId: string;
		parentRef: string;
		branchRef: string;
		branchName: string;
		connection: BranchConnection;
		envVar: string;
		envFile: string;
		strategy: string | null;
		notice: string | null;
	}): WorktreeBranchRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO worktree_branches (
				id, worktree_id, project_id, source_kind, account_id, source_connection_id,
				parent_ref, branch_ref, branch_name,
				connection_json, connection_id, env_var, env_file, env_status, env_detail,
				status, error, strategy, notice, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'failed', NULL, 'active', NULL, ?, ?, ?, ?)
		`).run(
			id,
			input.worktreeId,
			input.projectId,
			input.sourceKind,
			input.sourceKind === 'account' ? input.sourceId : null,
			input.sourceKind === 'connection' ? input.sourceId : null,
			input.parentRef,
			input.branchRef,
			input.branchName,
			sealFor(BRANCH_TABLE, 'connection_json', JSON.stringify(input.connection)),
			input.envVar,
			input.envFile,
			input.strategy,
			input.notice,
			now,
			now
		);

		return this.getById(id)!;
	},

	/** Every branch copied from one DB Client connection. */
	getForSourceConnection(connectionId: string): WorktreeBranchRow[] {
		const db = getDatabase();
		return openRows(
			BRANCH_TABLE,
			db.prepare(
				`SELECT * FROM worktree_branches WHERE source_connection_id = ? ORDER BY created_at DESC`
			).all(connectionId) as WorktreeBranchRow[]
		);
	},

	/**
	 * Record what happened when the connection string was written.
	 *
	 * Separate from `create` on purpose, and the ORDER is the reason. The row is
	 * written BEFORE the dotenv file is touched, so a crash in between leaves a
	 * branch that is tracked and deletable rather than one nothing knows about.
	 * That means the row exists for a moment with no env result — and the
	 * column's default of `failed` is the honest reading of that moment, because
	 * a process that died there genuinely did not write anything.
	 */
	setEnvResult(id: string, status: BranchEnvStatus, detail: string | null): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE worktree_branches SET env_status = ?, env_detail = ?, updated_at = ? WHERE id = ?`
		).run(status, detail, new Date().toISOString(), id);
	},

	/** Remember which DB Client connection this branch projected. */
	setConnectionId(id: string, connectionId: string | null): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE worktree_branches SET connection_id = ?, updated_at = ? WHERE id = ?`
		).run(connectionId, new Date().toISOString(), id);
	},

	/**
	 * Mark a branch as leaked.
	 *
	 * Called when the remote delete failed. The row deliberately keeps its
	 * connection and its refs: they are exactly what a later retry needs, and
	 * clearing them would turn a reportable orphan into an unreachable one.
	 */
	markOrphaned(id: string, error: string): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE worktree_branches
			SET status = 'orphaned', error = ?, worktree_id = NULL, updated_at = ?
			WHERE id = ?
		`).run(error, new Date().toISOString(), id);
	},

	remove(id: string): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM worktree_branches WHERE id = ?`).run(id);
	}
};
