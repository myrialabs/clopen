/**
 * Issues & PRs surface queries — bindings and work links.
 *
 * Neither table holds a secret, so nothing here goes through the crypto layer:
 * a locator is `owner/repo` and the config is a behaviour flag. The credential
 * that reaches the provider always comes from `integration_accounts`.
 *
 * Nothing about a work item itself is stored. See migration 074 for why: the
 * provider is the truthful answer for titles, bodies and comments, and the only
 * fact that cannot be re-derived is which worktree someone opened for it.
 */

import { getDatabase } from '../index';
import type { WorkBindingConfig, WorkItemKind } from '$shared/types/work';
import { DEFAULT_BINDING_CONFIG } from '$shared/types/work';

export interface WorkBindingRow {
	project_id: string;
	account_id: string;
	locator: string;
	detected: number;
	default_branch: string | null;
	config_json: string;
	created_at: string;
	updated_at: string;
}

export interface WorkLinkRow {
	id: string;
	project_id: string;
	account_id: string;
	item_kind: WorkItemKind;
	item_identifier: string;
	item_title: string | null;
	item_url: string | null;
	worktree_id: string | null;
	session_id: string | null;
	branch: string | null;
	created_at: string;
}

/**
 * Parse the stored config over the defaults.
 *
 * Merging rather than replacing is deliberate: a config written before a new
 * option existed must not read back with that option `undefined`, because the
 * two places that consume it (`transitionOnStartWork`, `branchTemplate`) treat
 * undefined and null differently and one of them would start naming branches
 * `undefined-...`.
 */
export function parseBindingConfig(raw: string | null): WorkBindingConfig {
	if (!raw) return { ...DEFAULT_BINDING_CONFIG };
	try {
		const parsed = JSON.parse(raw) as Partial<WorkBindingConfig> | null;
		return { ...DEFAULT_BINDING_CONFIG, ...(parsed ?? {}) };
	} catch {
		return { ...DEFAULT_BINDING_CONFIG };
	}
}

export const workBindingQueries = {
	getForProject(projectId: string): WorkBindingRow[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM work_bindings WHERE project_id = ?`
		).all(projectId) as WorkBindingRow[];
	},

	get(projectId: string, accountId: string): WorkBindingRow | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM work_bindings WHERE project_id = ? AND account_id = ?`
		).get(projectId, accountId) as WorkBindingRow | null;
	},

	upsert(input: {
		projectId: string;
		accountId: string;
		locator: string;
		detected: boolean;
		defaultBranch?: string | null;
		config?: WorkBindingConfig;
	}): WorkBindingRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		const existing = this.get(input.projectId, input.accountId);

		db.prepare(`
			INSERT INTO work_bindings (
				project_id, account_id, locator, detected, default_branch, config_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project_id, account_id) DO UPDATE SET
				locator        = excluded.locator,
				detected       = excluded.detected,
				default_branch = excluded.default_branch,
				config_json    = excluded.config_json,
				updated_at     = excluded.updated_at
		`).run(
			input.projectId,
			input.accountId,
			input.locator,
			input.detected ? 1 : 0,
			input.defaultBranch ?? existing?.default_branch ?? null,
			JSON.stringify(input.config ?? parseBindingConfig(existing?.config_json ?? null)),
			existing?.created_at ?? now,
			now
		);

		return this.get(input.projectId, input.accountId)!;
	},

	/**
	 * Cache the default branch discovered by an API call.
	 *
	 * Separate from `upsert` so a background lookup cannot clobber a locator the
	 * user changed while it was in flight.
	 */
	setDefaultBranch(projectId: string, accountId: string, branch: string): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE work_bindings SET default_branch = ?, updated_at = ? WHERE project_id = ? AND account_id = ?`
		).run(branch, new Date().toISOString(), projectId, accountId);
	},

	remove(projectId: string, accountId: string): void {
		const db = getDatabase();
		db.prepare(
			`DELETE FROM work_bindings WHERE project_id = ? AND account_id = ?`
		).run(projectId, accountId);
	}
};

export const workLinkQueries = {
	getForProject(projectId: string): WorkLinkRow[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM work_links WHERE project_id = ? ORDER BY created_at DESC`
		).all(projectId) as WorkLinkRow[];
	},

	getByItem(
		projectId: string,
		accountId: string,
		itemKind: WorkItemKind,
		itemIdentifier: string
	): WorkLinkRow | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM work_links
			WHERE project_id = ? AND account_id = ? AND item_kind = ? AND item_identifier = ?
		`).get(projectId, accountId, itemKind, itemIdentifier) as WorkLinkRow | null;
	},

	/** Which item this branch was started from. The PR composer's whole lookup. */
	getByBranch(projectId: string, branch: string): WorkLinkRow | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM work_links
			WHERE project_id = ? AND branch = ?
			ORDER BY created_at DESC LIMIT 1
		`).get(projectId, branch) as WorkLinkRow | null;
	},

	upsert(input: {
		projectId: string;
		accountId: string;
		itemKind: WorkItemKind;
		itemIdentifier: string;
		itemTitle?: string | null;
		itemUrl?: string | null;
		worktreeId?: string | null;
		sessionId?: string | null;
		branch?: string | null;
	}): WorkLinkRow {
		const db = getDatabase();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO work_links (
				id, project_id, account_id, item_kind, item_identifier,
				item_title, item_url, worktree_id, session_id, branch, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project_id, account_id, item_kind, item_identifier) DO UPDATE SET
				item_title  = excluded.item_title,
				item_url    = excluded.item_url,
				worktree_id = excluded.worktree_id,
				session_id  = excluded.session_id,
				branch      = excluded.branch
		`).run(
			crypto.randomUUID(),
			input.projectId,
			input.accountId,
			input.itemKind,
			input.itemIdentifier,
			input.itemTitle ?? null,
			input.itemUrl ?? null,
			input.worktreeId ?? null,
			input.sessionId ?? null,
			input.branch ?? null,
			now
		);

		return this.getByItem(input.projectId, input.accountId, input.itemKind, input.itemIdentifier)!;
	},

	remove(id: string): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM work_links WHERE id = ?`).run(id);
	}
};
