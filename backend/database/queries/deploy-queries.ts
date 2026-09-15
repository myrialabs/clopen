/**
 * Deployments surface queries — bindings only.
 *
 * This table holds no secret, so nothing here goes through the crypto layer: a
 * locator is a provider project id and the config is two display preferences.
 * The credential that reaches the provider always comes from
 * `integration_accounts`.
 *
 * There is no second table. Unlike the Issues surface, which records which
 * worktree someone opened for an issue, a deployment leaves nothing local
 * behind that would outlive the remote record — so nothing about a deployment
 * is persisted at all. See migration 075.
 */

import { getDatabase } from '../index';
import type { DeployBindingConfig } from '$shared/types/deployments';
import { DEFAULT_DEPLOY_BINDING_CONFIG } from '$shared/types/deployments';

export interface DeployBindingRow {
	project_id: string;
	account_id: string;
	locator: string;
	display_name: string;
	team_id: string | null;
	detected: number;
	config_json: string;
	created_at: string;
	updated_at: string;
}

/**
 * Parse the stored config over the defaults.
 *
 * Merged rather than replaced for the reason `parseBindingConfig` is: a config
 * written before an option existed must not read back with that option
 * `undefined`, or `environment` becomes a filter nothing matches and the list
 * renders empty on a project that has deployments.
 */
export function parseDeployConfig(raw: string | null): DeployBindingConfig {
	if (!raw) return { ...DEFAULT_DEPLOY_BINDING_CONFIG };
	try {
		const parsed = JSON.parse(raw) as Partial<DeployBindingConfig> | null;
		return { ...DEFAULT_DEPLOY_BINDING_CONFIG, ...(parsed ?? {}) };
	} catch {
		return { ...DEFAULT_DEPLOY_BINDING_CONFIG };
	}
}

export const deployBindingQueries = {
	getForProject(projectId: string): DeployBindingRow[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM deploy_bindings WHERE project_id = ?`
		).all(projectId) as DeployBindingRow[];
	},

	get(projectId: string, accountId: string): DeployBindingRow | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM deploy_bindings WHERE project_id = ? AND account_id = ?`
		).get(projectId, accountId) as DeployBindingRow | null;
	},

	upsert(input: {
		projectId: string;
		accountId: string;
		locator: string;
		displayName: string;
		teamId: string | null;
		detected: boolean;
		config?: DeployBindingConfig;
	}): DeployBindingRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		const existing = this.get(input.projectId, input.accountId);

		db.prepare(`
			INSERT INTO deploy_bindings (
				project_id, account_id, locator, display_name, team_id, detected,
				config_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project_id, account_id) DO UPDATE SET
				locator      = excluded.locator,
				display_name = excluded.display_name,
				team_id      = excluded.team_id,
				detected     = excluded.detected,
				config_json  = excluded.config_json,
				updated_at   = excluded.updated_at
		`).run(
			input.projectId,
			input.accountId,
			input.locator,
			input.displayName,
			input.teamId,
			input.detected ? 1 : 0,
			JSON.stringify(input.config ?? parseDeployConfig(existing?.config_json ?? null)),
			existing?.created_at ?? now,
			now
		);

		return this.get(input.projectId, input.accountId)!;
	},

	/**
	 * Store the config alone.
	 *
	 * Separate from `upsert` so toggling auto-refresh cannot clobber a locator
	 * the user repointed while the toggle was in flight — the same race
	 * `setDefaultBranch` avoids on the Issues side.
	 */
	setConfig(projectId: string, accountId: string, config: DeployBindingConfig): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE deploy_bindings SET config_json = ?, updated_at = ? WHERE project_id = ? AND account_id = ?`
		).run(JSON.stringify(config), new Date().toISOString(), projectId, accountId);
	},

	remove(projectId: string, accountId: string): void {
		const db = getDatabase();
		db.prepare(
			`DELETE FROM deploy_bindings WHERE project_id = ? AND account_id = ?`
		).run(projectId, accountId);
	}
};
