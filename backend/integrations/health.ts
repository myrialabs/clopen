/**
 * Account health, and the health of the secrets layer itself.
 *
 * Account health reuses the MCP probe rather than inventing a second notion of
 * "is this connector working" — for an account whose only capability is agent
 * tools, the probe against its projected row IS the answer.
 *
 * That answer runs out the moment a capability projects no MCP row. A GitHub
 * account offering `work` has a credential that can be verified precisely —
 * by calling the API it was issued for — but nothing for `probeServer()` to
 * reach. So a surface may register its own probe for its providers, and the
 * hub's status strip keeps meaning something for every account rather than
 * reading "Nothing to probe yet" forever.
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
 * A probe contributed by a surface, keyed by provider id.
 *
 * Returning null means "this probe has nothing to say about this account" — for
 * instance a GitHub account with `work` switched off — and the MCP path is
 * used instead. That is what lets one account carry both kinds of capability
 * without the two probes fighting over which one reports.
 */
export type AccountProbe = (
	accountId: string,
	projectId: string | null
) => Promise<{ status: IntegrationStatus; detail: string | null } | null>;

const providerProbes = new Map<string, AccountProbe>();

/** Register a provider-specific probe. Called at module load by the surface. */
export function registerAccountProbe(provider: string, probe: AccountProbe): void {
	providerProbes.set(provider, probe);
}

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

	// A surface probe is the more specific answer when there is one: it talks to
	// the API the credential was issued for, rather than to an MCP server that
	// happens to accept the same token.
	const providerProbe = providerProbes.get(account.provider);
	if (providerProbe) {
		try {
			const result = await providerProbe(accountId, account.project_id);
			if (result) {
				integrationAccounts.setStatus(accountId, result.status, result.detail);
				return result;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			debug.error('integrations', `Provider probe failed for account ${accountId}:`, error);
			integrationAccounts.setStatus(accountId, 'error', detail);
			return { status: 'error', detail };
		}
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
