/**
 * The `agent-tools` projector: an account with agent tools owns one
 * `mcp_servers` row.
 *
 * Nothing downstream of this row knows accounts exist. `resolveServerRow()`,
 * every per-engine config builder and the `/mcp/ext/<slug>` proxy read the row
 * exactly as they read a hand-installed one — which is the whole point of
 * keeping this layer off the path MCP config already flows through.
 */

import { mcpServerQueries, integrationProjectionQueries } from '$backend/database/queries';
import type { McpServerRow } from '$backend/database/queries';
import type { McpPreset } from '../registry';
import type { Projector, ProjectionContext, ProjectionResult } from './types';
import { debug } from '$shared/utils/logger';

/** Snapshot of the credential-bearing fields, taken before an adopted row is written. */
interface McpRestoreSnapshot {
	env: Record<string, string>;
	headers: Record<string, string>;
}

function parseMap(raw: string | null): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Map the stored credential onto the env vars the upstream server expects,
 * keeping any keys already on the row.
 *
 * Merging rather than replacing matters for adoption: a user who installed this
 * server by hand may have set env vars the preset says nothing about, and
 * connecting an account must not silently drop them.
 */
function buildEnv(preset: McpPreset, credentials: Record<string, string>, existing: Record<string, string>): Record<string, string> {
	const env = { ...existing, ...(preset.staticEnv ?? {}) };
	for (const [field, variable] of Object.entries(preset.env ?? {})) {
		const value = credentials[field];
		if (value) env[variable] = value;
	}
	return env;
}

/** Same, for the remote path. `format` wraps the value, `Bearer {value}` being the usual case. */
function buildHeaders(preset: McpPreset, credentials: Record<string, string>, existing: Record<string, string>): Record<string, string> {
	const headers = { ...existing, ...(preset.staticHeaders ?? {}) };
	for (const [field, spec] of Object.entries(preset.headers ?? {})) {
		const value = credentials[field];
		if (!value) continue;
		headers[spec.name] = spec.format ? spec.format.replace('{value}', value) : value;
	}
	return headers;
}

function presetOf(context: ProjectionContext): McpPreset {
	const preset = context.provider.mcp;
	if (!preset) {
		throw new Error(`Provider "${context.provider.id}" offers agent tools but declares no MCP preset`);
	}
	return preset;
}

export const mcpProjector: Projector = {
	capability: 'agent-tools',
	targetKind: 'mcp_server',

	project(context: ProjectionContext): ProjectionResult {
		const preset = presetOf(context);
		const existing: McpServerRow | null = mcpServerQueries.getBySlug(preset.slug);

		if (!existing) {
			const row = mcpServerQueries.insert({
				slug: preset.slug,
				name: preset.name,
				description: preset.description,
				transport: preset.transport,
				command: preset.command ?? null,
				args: preset.args ?? [],
				url: preset.url ?? null,
				env: buildEnv(preset, context.credentials, {}),
				headers: buildHeaders(preset, context.credentials, {}),
				// Registry-installed vs hand-written is a provenance question about
				// the CONFIG. Ownership by an account is a different question, and
				// `integration_projections` is where it is answered — so this stays
				// an ordinary custom row rather than needing a fourth source value.
				source: 'custom'
			});
			return { targetKind: 'mcp_server', targetId: String(row.id), adopted: false, restore: null };
		}

		// ADOPT rather than create a sibling. A user who installed this server by
		// hand before the provider existed must end up with ONE entry.
		const targetId = String(existing.id);
		const prior = integrationProjectionQueries.getByTarget('mcp_server', targetId);

		if (prior && prior.account_id !== context.account.id) {
			throw new Error(
				`The "${preset.slug}" connector is already managed by another connected account. ` +
				`Disconnect that one first.`
			);
		}

		// Re-projecting a row we already own must not re-snapshot it — the second
		// snapshot would capture OUR credential, and release would then "restore"
		// the user's row to the token we are about to delete.
		const adopted = prior ? prior.adopted === 1 : true;
		const restore = prior
			? integrationProjectionQueries.restoreOf<McpRestoreSnapshot>(prior)
			: ({ env: parseMap(existing.env), headers: parseMap(existing.headers) } satisfies McpRestoreSnapshot);

		if (!prior) {
			debug.log('integrations', `Adopting existing MCP server "${preset.slug}" for ${context.provider.id}`);
		}

		mcpServerQueries.updateConfig(
			existing.id,
			buildEnv(preset, context.credentials, parseMap(existing.env)),
			buildHeaders(preset, context.credentials, parseMap(existing.headers))
		);

		// Only a row we created gets its transport-level config rewritten. On an
		// adopted row the user's command, args and URL are theirs, and a preset
		// that thinks it knows better would break a working server.
		if (!adopted) {
			if (preset.transport === 'stdio' && preset.command) {
				mcpServerQueries.updateCommand(existing.id, preset.command, preset.args ?? []);
			}
		}

		return { targetKind: 'mcp_server', targetId, adopted, restore };
	},

	release(context: ProjectionContext, targetId: string, adopted: boolean, restore: unknown | null): void {
		const id = Number(targetId);
		if (!Number.isFinite(id)) return;

		if (!adopted) {
			mcpServerQueries.remove(id);
			return;
		}

		// The row was the user's before it was ours. Put back exactly what we
		// found, so what is left behind is their server, not a husk pointing at a
		// credential that no longer exists.
		const snapshot = (restore ?? { env: {}, headers: {} }) as McpRestoreSnapshot;
		if (mcpServerQueries.getById(id)) {
			mcpServerQueries.updateConfig(id, snapshot.env ?? {}, snapshot.headers ?? {});
			debug.log('integrations', `Released adopted MCP server ${id} back to the user (${context.provider.id})`);
		}
	}
};
