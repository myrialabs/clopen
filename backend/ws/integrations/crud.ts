/**
 * Integration account handlers.
 *
 *   integrations:providers   — the registry, as the catalogue renders it
 *   integrations:list        — connected accounts (never credential values)
 *   integrations:connect     — create an account and project its capabilities
 *   integrations:update      — credentials / capabilities / project / enabled
 *   integrations:disconnect  — release every projection, then drop the account
 *   integrations:health      — probe one account
 *   integrations:secrets-health — state of secrets at rest, for the hub banner
 *
 * Admin-gated in `backend/auth/permissions.ts`, matching the MCP surface it
 * absorbs: connecting an account changes what every engine and every project
 * can reach.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import {
	checkAccountHealth,
	getSecretsHealth,
	integrationAccounts,
	listProviderInfo
} from '$backend/integrations';
import { INTEGRATION_CAPABILITIES, INTEGRATION_CATEGORIES } from '$shared/types/integrations';
import type { IntegrationCapability } from '$shared/types/integrations';
import { ws as wsServer } from '$backend/utils/ws';

/**
 * Tell every connected client an account changed.
 *
 * Global rather than per-project: an account can be bound to a project, but the
 * connector row it projects is instance-wide, and the hub is an instance-wide
 * screen.
 */
function announce(accountId?: string): void {
	wsServer.emit.global('integrations:changed', accountId ? { accountId } : {});
}

const CAPABILITY_SCHEMA = t.Union(INTEGRATION_CAPABILITIES.map((capability) => t.Literal(capability)));
const CATEGORY_SCHEMA = t.Union(INTEGRATION_CATEGORIES.map((category) => t.Literal(category)));

const STATUS_SCHEMA = t.Union([
	t.Literal('unknown'),
	t.Literal('ok'),
	t.Literal('needs_auth'),
	t.Literal('needs_config'),
	t.Literal('error')
]);

const AUTH_METHOD_SCHEMA = t.Union([
	t.Literal('api-key'),
	t.Literal('oauth-device'),
	t.Literal('oauth-code'),
	t.Literal('mcp-oauth'),
	t.Literal('connection-string'),
	t.Literal('none')
]);

const CREDENTIAL_FIELD_SCHEMA = t.Object({
	name: t.String(),
	label: t.String(),
	placeholder: t.Optional(t.String()),
	help: t.Optional(t.String()),
	isSecret: t.Boolean(),
	isRequired: t.Boolean()
});

const PROVIDER_SCHEMA = t.Object({
	id: t.String(),
	name: t.String(),
	category: CATEGORY_SCHEMA,
	description: t.String(),
	docsUrl: t.Optional(t.String()),
	authMethod: AUTH_METHOD_SCHEMA,
	credentialFields: t.Array(CREDENTIAL_FIELD_SCHEMA),
	capabilities: t.Array(CAPABILITY_SCHEMA),
	defaultCapabilities: t.Array(CAPABILITY_SCHEMA),
	providesAgentTools: t.Boolean(),
	acceptsWebhooks: t.Boolean()
});

const ACCOUNT_SCHEMA = t.Object({
	id: t.String(),
	provider: t.String(),
	label: t.String(),
	projectId: t.Union([t.String(), t.Null()]),
	authMethod: AUTH_METHOD_SCHEMA,
	// Which fields hold a value — NOT the values. A credential that reached the
	// client would be a credential in a log, a screenshot and a bug report.
	configuredFields: t.Array(t.String()),
	capabilities: t.Array(CAPABILITY_SCHEMA),
	status: STATUS_SCHEMA,
	statusDetail: t.Union([t.String(), t.Null()]),
	checkedAt: t.Union([t.String(), t.Null()]),
	isEnabled: t.Boolean(),
	createdAt: t.String(),
	updatedAt: t.String(),
	projections: t.Array(t.Object({
		capability: CAPABILITY_SCHEMA,
		targetKind: t.Union([t.Literal('mcp_server'), t.Literal('db_client_connection')]),
		targetId: t.String(),
		adopted: t.Boolean()
	}))
});

const SECRETS_HEALTH_SCHEMA = t.Object({
	keySource: t.Union([t.Literal('env'), t.Literal('file')]),
	keyFingerprint: t.String(),
	failureCount: t.Number(),
	lastFailureAt: t.Union([t.String(), t.Null()]),
	unknownKeyFingerprints: t.Array(t.String()),
	unsealedColumns: t.Array(t.Object({
		table: t.String(),
		column: t.String(),
		count: t.Number()
	}))
});

export const integrationsCrudHandler = createRouter()
	.http('integrations:providers', {
		data: t.Object({}),
		response: t.Object({ providers: t.Array(PROVIDER_SCHEMA) })
	}, async () => {
		debug.log('path', 'integrations:providers');
		return { providers: listProviderInfo() };
	})

	.http('integrations:list', {
		data: t.Object({}),
		response: t.Object({ accounts: t.Array(ACCOUNT_SCHEMA) })
	}, async () => {
		debug.log('path', 'integrations:list');
		return { accounts: integrationAccounts.list() };
	})

	.http('integrations:connect', {
		data: t.Object({
			provider: t.String(),
			label: t.Optional(t.String()),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			credentials: t.Record(t.String(), t.String()),
			capabilities: t.Optional(t.Array(CAPABILITY_SCHEMA))
		}),
		response: t.Object({ account: ACCOUNT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `integrations:connect ${data.provider}`);
		const account = integrationAccounts.connect({
			provider: data.provider,
			label: data.label,
			projectId: data.projectId ?? null,
			credentials: data.credentials,
			capabilities: data.capabilities as IntegrationCapability[] | undefined
		});
		announce(account.id);
		return { account };
	})

	/**
	 * One update handler rather than four.
	 *
	 * Every field here re-projects, and splitting them into separate events
	 * would just be four ways to reach the same pass. Absent fields are left
	 * alone; an empty credential value means "not re-typed", not "clear".
	 */
	.http('integrations:update', {
		data: t.Object({
			id: t.String(),
			credentials: t.Optional(t.Record(t.String(), t.String())),
			capabilities: t.Optional(t.Array(CAPABILITY_SCHEMA)),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			enabled: t.Optional(t.Boolean())
		}),
		response: t.Object({ account: ACCOUNT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `integrations:update ${data.id}`);

		if (data.credentials) integrationAccounts.updateCredentials(data.id, data.credentials);
		if (data.capabilities) integrationAccounts.setCapabilities(data.id, data.capabilities as IntegrationCapability[]);
		if (data.projectId !== undefined) integrationAccounts.setProject(data.id, data.projectId);
		if (data.enabled !== undefined) integrationAccounts.setEnabled(data.id, data.enabled);

		const account = integrationAccounts.get(data.id);
		if (!account) throw new Error('Integration account not found');
		announce(account.id);
		return { account };
	})

	.http('integrations:disconnect', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `integrations:disconnect ${data.id}`);
		integrationAccounts.disconnect(data.id);
		announce(data.id);
		return { success: true };
	})

	.http('integrations:health', {
		data: t.Object({ id: t.String() }),
		response: t.Object({
			status: STATUS_SCHEMA,
			detail: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		debug.log('path', `integrations:health ${data.id}`);
		return checkAccountHealth(data.id);
	})

	.http('integrations:secrets-health', {
		data: t.Object({}),
		response: t.Object({ health: SECRETS_HEALTH_SCHEMA })
	}, async () => {
		debug.log('path', 'integrations:secrets-health');
		return { health: getSecretsHealth() };
	});
