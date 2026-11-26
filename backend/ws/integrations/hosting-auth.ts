/**
 * Signing in to a git hosting service — every way in, one route each.
 *
 *   integrations:hosting-detect          logins already on this machine (gh, glab, tea)
 *   integrations:hosting-probe-server    what a self-hosted URL is
 *   integrations:hosting-connect-cli     borrow a CLI login (linked or copied)
 *   integrations:hosting-connect-keychain  read git's credential store, once
 *   integrations:hosting-connect-token   a pasted token, verified before it is stored
 *   integrations:hosting-device-start    OAuth device flow
 *   integrations:hosting-browser-start   OAuth authorization code + PKCE
 *   integrations:hosting-auth-poll       how a started flow is going
 *   integrations:hosting-auth-cancel     stop waiting for one
 *   integrations:hosting-callback-uri    the redirect URI to register on an OAuth app
 *
 * Every connect route takes an optional `accountId`, which reconnects that
 * account instead of creating one — the same dialog serves "Connect" and
 * "Sign in again".
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import {
	cancelFlow,
	connectFromCli,
	connectFromKeychain,
	connectHostAccount,
	detectLocal,
	isGitHostKind,
	oauthCallbackUri,
	pollFlow,
	probeServer,
	startBrowserFlow,
	startDeviceFlow
} from '$backend/git-hosts';
import type { GitHostKind } from '$shared/types/git-hosting';
import type { IntegrationCapability } from '$shared/types/integrations';
import { ACCOUNT_SCHEMA, CAPABILITY_SCHEMA, announce } from './crud';

const HOST_KIND_SCHEMA = t.Union([t.Literal('github'), t.Literal('gitlab'), t.Literal('gitea'), t.Literal('bitbucket')]);

const TARGET_FIELDS = {
	provider: HOST_KIND_SCHEMA,
	label: t.Optional(t.String({ maxLength: 120 })),
	projectId: t.Optional(t.Union([t.String(), t.Null()])),
	capabilities: t.Optional(t.Array(CAPABILITY_SCHEMA)),
	accountId: t.Optional(t.Union([t.String(), t.Null()]))
};

const VIEWER_SCHEMA = t.Object({
	login: t.String(),
	name: t.Union([t.String(), t.Null()]),
	avatarUrl: t.Union([t.String(), t.Null()]),
	scopes: t.Union([t.Array(t.String()), t.Null()]),
	missingScopes: t.Array(t.String())
});

const CONNECTED_SCHEMA = t.Object({ account: ACCOUNT_SCHEMA, viewer: VIEWER_SCHEMA });

function kindOf(provider: string): GitHostKind {
	if (!isGitHostKind(provider)) throw new Error(`"${provider}" is not a git hosting service`);
	return provider;
}

export const hostingAuthHandler = createRouter()
	.http('integrations:hosting-detect', {
		data: t.Object({ provider: HOST_KIND_SCHEMA, baseUrl: t.Optional(t.String()) }),
		response: t.Object({
			found: t.Array(t.Object({
				source: t.Union([t.Literal('gh'), t.Literal('glab'), t.Literal('tea'), t.Literal('keychain')]),
				host: t.String(),
				login: t.Union([t.String(), t.Null()]),
				hasToken: t.Boolean(),
				canLink: t.Boolean()
			}))
		})
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-detect ${data.provider}`);
		return { found: await detectLocal(kindOf(data.provider), data.baseUrl) };
	})

	.http('integrations:hosting-probe-server', {
		data: t.Object({ url: t.String({ minLength: 1, maxLength: 500 }) }),
		response: t.Object({
			provider: t.Union([HOST_KIND_SCHEMA, t.Null()]),
			flavour: t.Union([
				t.Literal('github-enterprise'),
				t.Literal('gitlab'),
				t.Literal('gitea'),
				t.Literal('forgejo'),
				t.Null()
			]),
			version: t.Union([t.String(), t.Null()]),
			baseUrl: t.String()
		})
	}, async ({ data }) => probeServer(data.url))

	.http('integrations:hosting-connect-cli', {
		data: t.Object({
			...TARGET_FIELDS,
			host: t.String({ minLength: 1 }),
			mode: t.Union([t.Literal('linked'), t.Literal('copy')])
		}),
		response: CONNECTED_SCHEMA
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-connect-cli ${data.provider} ${data.mode}`);
		const result = await connectFromCli({
			provider: kindOf(data.provider),
			host: data.host.toLowerCase(),
			mode: data.mode,
			label: data.label,
			projectId: data.projectId ?? null,
			capabilities: data.capabilities as IntegrationCapability[] | undefined,
			accountId: data.accountId ?? null
		});
		announce(result.account.id);
		return result;
	})

	.http('integrations:hosting-connect-keychain', {
		data: t.Object({ ...TARGET_FIELDS, baseUrl: t.Optional(t.String()) }),
		response: CONNECTED_SCHEMA
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-connect-keychain ${data.provider}`);
		const result = await connectFromKeychain({
			provider: kindOf(data.provider),
			baseUrl: data.baseUrl,
			label: data.label,
			projectId: data.projectId ?? null,
			capabilities: data.capabilities as IntegrationCapability[] | undefined,
			accountId: data.accountId ?? null
		});
		announce(result.account.id);
		return result;
	})

	.http('integrations:hosting-connect-token', {
		data: t.Object({ ...TARGET_FIELDS, fields: t.Record(t.String(), t.String()) }),
		response: CONNECTED_SCHEMA
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-connect-token ${data.provider}`);
		const result = await connectHostAccount({
			provider: kindOf(data.provider),
			accountId: data.accountId ?? null,
			label: data.label,
			projectId: data.projectId ?? null,
			capabilities: data.capabilities as IntegrationCapability[] | undefined,
			authMethod: 'api-key',
			source: 'token',
			fields: data.fields
		});
		announce(result.account.id);
		return result;
	})

	.http('integrations:hosting-device-start', {
		data: t.Object({ ...TARGET_FIELDS, baseUrl: t.Optional(t.String()), clientId: t.Optional(t.String()) }),
		response: t.Object({
			flowId: t.String(),
			userCode: t.String(),
			verificationUri: t.String(),
			verificationUriComplete: t.Union([t.String(), t.Null()]),
			expiresAt: t.String(),
			intervalSeconds: t.Number()
		})
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-device-start ${data.provider}`);
		return startDeviceFlow({
			provider: kindOf(data.provider),
			baseUrl: data.baseUrl,
			clientId: data.clientId,
			label: data.label,
			projectId: data.projectId ?? null,
			capabilities: data.capabilities as IntegrationCapability[] | undefined,
			accountId: data.accountId ?? null
		});
	})

	.http('integrations:hosting-browser-start', {
		data: t.Object({ ...TARGET_FIELDS, baseUrl: t.Optional(t.String()), clientId: t.Optional(t.String()) }),
		response: t.Object({ flowId: t.String(), authorizeUrl: t.String(), redirectUri: t.String() })
	}, async ({ data }) => {
		debug.log('path', `integrations:hosting-browser-start ${data.provider}`);
		return startBrowserFlow({
			provider: kindOf(data.provider),
			baseUrl: data.baseUrl,
			clientId: data.clientId,
			label: data.label,
			projectId: data.projectId ?? null,
			capabilities: data.capabilities as IntegrationCapability[] | undefined,
			accountId: data.accountId ?? null
		});
	})

	.http('integrations:hosting-auth-poll', {
		data: t.Object({ flowId: t.String({ minLength: 1 }) }),
		response: t.Object({
			status: t.Union([
				t.Literal('pending'),
				t.Literal('success'),
				t.Literal('expired'),
				t.Literal('denied'),
				t.Literal('error')
			]),
			accountId: t.Union([t.String(), t.Null()]),
			error: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		const result = pollFlow(data.flowId);
		if (result.status === 'success' && result.accountId) announce(result.accountId);
		return result;
	})

	// The redirect URI a user registers on their own OAuth app. Asked of the
	// server because only it knows the port it listens on.
	.http('integrations:hosting-callback-uri', {
		data: t.Object({}),
		response: t.Object({ uri: t.String() })
	}, async () => ({ uri: oauthCallbackUri() }))

	.http('integrations:hosting-auth-cancel', {
		data: t.Object({ flowId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		cancelFlow(data.flowId);
		return { ok: true };
	});
