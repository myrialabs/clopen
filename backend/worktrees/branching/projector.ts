/**
 * The `worktree-branching` projector: an account owns one
 * `db_client_connections` row per live worktree branch.
 *
 * Without this a branch would be a connection string in a dotenv file and
 * nothing more — the user could see that their agent had run migrations and
 * have no way to look at what those migrations did. With it, the branch is a
 * connection like any other: the schema tree, the ER diagram and the query
 * console read it without knowing it is derived, which is the whole point of
 * keeping this layer off the path every connection already flows through.
 *
 * DELIBERATELY NOT A `integration_db_links` ROW, even though a link is the same
 * shape. A link is user-managed: it appears in the link dialog and it has an
 * Unlink button. Unlinking a worktree's branch would tear the connection out
 * from under a live worktree while leaving the branch itself running, so the
 * two are kept as separate projectors of separate tables — and because
 * migration 077 widened the projection key with `target_id`, one account can
 * own rows under both capabilities without either releasing the other's.
 *
 * NOTHING IS EVER ADOPTED here, which is the one way this projector is simpler
 * than DB Client's. Adoption exists so a connection someone typed by hand
 * before connecting an account ends up as one row rather than two. A branch
 * that was created seconds ago, on a host the provider just minted, cannot have
 * been typed in by anyone — so a row is always created and always deleted, and
 * there is no snapshot to restore.
 */

import {
	dbClientConnectionQueries,
	worktreeBranchQueries,
	worktreeQueries,
	type WorktreeBranchRow
} from '$backend/database/queries';
import type { Projector, ProjectionContext, ProjectionResult } from '$backend/integrations';
import { getBranchProvider } from './registry';
import { debug } from '$shared/utils/logger';

/**
 * What the connection is called in DB Client's list.
 *
 * The WORKTREE's name, not the branch's: the list is global, and "fix login
 * (branch)" is the question someone actually has. The provider's own noun is
 * used so a Turso row does not call a seeded database a branch.
 */
function connectionNameFor(row: WorktreeBranchRow, noun: string): string {
	const worktree = row.worktree_id ? worktreeQueries.getById(row.worktree_id) : null;
	return `${worktree?.name ?? row.branch_name} (${noun})`;
}

/**
 * The branches that should own a connection right now.
 *
 * ACTIVE and still attached to a worktree. An orphan is deliberately excluded:
 * its remote database may well still exist — that is what makes it an orphan —
 * but the worktree it belonged to is gone, so leaving a connection behind would
 * clutter every admin's list with rows pointing at databases nobody is using.
 * The orphan list is where those live, and it offers a delete rather than a
 * connection.
 */
function liveBranchesOf(accountId: string): WorktreeBranchRow[] {
	return worktreeBranchQueries
		.getForAccount(accountId)
		.filter((row) => row.status === 'active' && row.worktree_id !== null);
}

export const worktreeBranchProjector: Projector = {
	capability: 'worktree-branching',
	targetKind: 'db_client_connection',

	project(context: ProjectionContext): ProjectionResult[] {
		const noun = getBranchProvider(context.account.provider)?.info().noun ?? 'branch';
		const results: ProjectionResult[] = [];

		for (const row of liveBranchesOf(context.account.id)) {
			const connection = worktreeBranchQueries.connectionOf(row);
			if (!connection) {
				// The sealed blob could not be opened — a key that changed, or a
				// restore from a backup without it. The branch stays listed and stays
				// deletable; it simply projects nothing, which is the same
				// degradation every other read path in the secrets layer takes.
				debug.warn('worktree', `Branch ${row.id} has no readable connection — nothing to project`);
				continue;
			}

			const fields = {
				driver: 'postgres' as const,
				host: connection.host,
				port: connection.port,
				username: connection.username,
				database: connection.database,
				sslMode: connection.sslMode,
				options: { worktreeBranch: { branchId: row.id, worktreeId: row.worktree_id } }
			};

			const existing = row.connection_id ? dbClientConnectionQueries.get(row.connection_id) : null;

			if (!existing) {
				const created = dbClientConnectionQueries.create({
					name: connectionNameFor(row, noun),
					password: connection.password,
					...fields
				});
				worktreeBranchQueries.setConnectionId(row.id, created.id);
				results.push({
					targetKind: 'db_client_connection',
					targetId: created.id,
					adopted: false,
					restore: null
				});
				continue;
			}

			dbClientConnectionQueries.update(existing.id, {
				name: connectionNameFor(row, noun),
				...fields
			});
			// Through `replacePassword`, not the patch: a patch reads an empty
			// password as "not re-typed", which is right for a form and wrong for a
			// derived row that must equal what it was derived from.
			dbClientConnectionQueries.replacePassword(existing.id, connection.password);

			results.push({
				targetKind: 'db_client_connection',
				targetId: existing.id,
				adopted: false,
				restore: null
			});
		}

		return results;
	},

	release(_context: ProjectionContext, targetId: string): void {
		// Always ours, never adopted — so always a delete. The branch row keeps
		// its `connection_id` pointing at a row that no longer exists, which the
		// next projection treats as "never projected" and recreates.
		dbClientConnectionQueries.delete(targetId);
	}
};
