/**
 * Account health, and the health of the secrets layer itself.
 *
 * Account health reuses the MCP probe rather than inventing a second notion of
 * "is this connector working" — for an account whose only capability is agent
 * tools, the probe against its projected row IS the answer.
 */

import { probeServer, resolveServerRow } from '$backend/mcp';
import {
	integrationAccountQueries,
	integrationProjectionQueries,
	mcpServerQueries
} from '$backend/database/queries';
import { getDatabase } from '$backend/database';
import { auditSecretColumns, getDecryptFailures, getMasterKey } from '$backend/database/crypto';
import type { IntegrationStatus, SecretsHealth } from '$shared/types/integrations';
import { integrationAccounts } from './accounts';
import { debug } from '$shared/utils/logger';

/**
 * Probe one account.
 *
 * An account with no projected MCP row has nothing probeable yet — its
 * capabilities belong to surfaces that do not exist. That is reported as
 * `unknown` rather than `ok`, because claiming health we never measured is the
 * one answer worse than "not checked".
 */
export async function checkAccountHealth(accountId: string): Promise<{ status: IntegrationStatus; detail: string | null }> {
	const account = integrationAccountQueries.getById(accountId);
	if (!account) throw new Error('Integration account not found');

	if (account.is_enabled !== 1) {
		const result = { status: 'unknown' as const, detail: 'Disabled' };
		integrationAccounts.setStatus(accountId, result.status, result.detail);
		return result;
	}

	const projection = integrationProjectionQueries
		.getForAccount(accountId)
		.find((row) => row.target_kind === 'mcp_server');

	if (!projection) {
		const result = { status: 'unknown' as const, detail: 'Nothing to probe yet' };
		integrationAccounts.setStatus(accountId, result.status, result.detail);
		return result;
	}

	const row = mcpServerQueries.getById(Number(projection.target_id));
	if (!row) {
		const result = { status: 'error' as const, detail: 'Projected connector is missing' };
		integrationAccounts.setStatus(accountId, result.status, result.detail);
		return result;
	}

	try {
		const health = await probeServer(resolveServerRow(row));
		// The probe's `unreachable` and `local` states have no account-level
		// meaning: one is an error and the other means "nothing to reach".
		const status: IntegrationStatus =
			health.state === 'ok' ? 'ok'
			: health.state === 'needs_auth' ? 'needs_auth'
			: health.state === 'needs_config' ? 'needs_config'
			: health.state === 'local' ? 'unknown'
			: 'error';

		integrationAccounts.setStatus(accountId, status, health.message ?? null);
		return { status, detail: health.message ?? null };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		debug.error('integrations', `Health check failed for account ${accountId}:`, error);
		integrationAccounts.setStatus(accountId, 'error', detail);
		return { status: 'error', detail };
	}
}

/**
 * State of secrets at rest, rendered by the hub as a banner.
 *
 * A non-zero failure count is almost always a database restored next to a
 * freshly generated key. Surfacing the fingerprints is what turns that from
 * "some credentials stopped working" into "you are missing key 3f9a1c22".
 */
export function getSecretsHealth(): SecretsHealth {
	const { fingerprint, source } = getMasterKey();
	const failures = getDecryptFailures();

	const unsealedColumns = auditSecretColumns(getDatabase())
		.filter((entry) => entry.unsealed > 0)
		.map((entry) => ({ table: entry.table, column: entry.column, count: entry.unsealed }));

	return {
		keySource: source,
		keyFingerprint: fingerprint,
		failureCount: failures.count,
		lastFailureAt: failures.lastAt,
		unknownKeyFingerprints: failures.fingerprints,
		unsealedColumns
	};
}
