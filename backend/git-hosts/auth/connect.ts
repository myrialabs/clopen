/**
 * Turning a credential — however it was obtained — into a connected account.
 *
 * Every sign-in method ends here: a CLI login, a device-flow token, a browser
 * sign-in, a keychain entry, or a pasted token. The credential is VERIFIED
 * before anything is stored, so an account never appears in the list until it
 * has proved it can reach the service, and the login it belongs to is recorded
 * so two accounts on one host can be told apart by owner.
 *
 * Reconnecting an existing account goes through the same path with
 * `accountId`, replacing the keys the previous method owned. A token pasted
 * over a CLI-linked account must stop re-reading the CLI.
 */

import { integrationAccounts, getProvider } from '$backend/integrations';
import { integrationAccountQueries } from '$backend/database/queries';
import type { IntegrationAccountInfo, IntegrationAuthMethod, IntegrationCapability } from '$shared/types/integrations';
import type { GitHostKind, HostViewer } from '$shared/types/git-hosting';
import { debug } from '$shared/utils/logger';
import { getHostAdapter } from '../registry';
import { normaliseBaseUrl } from '../urls';
import { forgetOwners, rememberOwners } from '../accounts';
import { forgetCachedCliToken, type AuthSource } from '../credentials';

/** Keys a sign-in method writes. Cleared whenever an account switches method. */
const METHOD_KEYS = ['authSource', 'cliTool', 'cliHost', 'refreshToken', 'expiresAt', 'clientId', 'login'];

export interface HostConnectInput {
	provider: GitHostKind;
	/** Replace this account's credential instead of creating a new one. */
	accountId?: string | null;
	label?: string;
	projectId?: string | null;
	capabilities?: IntegrationCapability[];
	authMethod: IntegrationAuthMethod;
	source: AuthSource;
	/** The provider's own fields — `token`, `baseUrl`, `email`. */
	fields: Record<string, string>;
	/** Sign-in bookkeeping — `cliTool`, `refreshToken`, `expiresAt`, `clientId`. */
	extra?: Record<string, string>;
}

/**
 * A label that says WHO, not just which service.
 *
 * "GitHub" is fine for the first account and useless for the second; the
 * login is what a user actually tells their accounts apart by.
 */
function labelFor(providerName: string, login: string, provider: string): string {
	const taken = new Set(integrationAccountQueries.getByProvider(provider).map((row) => row.label));
	const base = `${providerName} (${login})`;
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base} ${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export async function connectHostAccount(input: HostConnectInput): Promise<{ account: IntegrationAccountInfo; viewer: HostViewer }> {
	const adapter = getHostAdapter(input.provider);
	const provider = getProvider(input.provider);
	if (!adapter || !provider) throw new Error(`Unknown hosting provider "${input.provider}"`);

	const fields = { ...input.fields };
	if ('baseUrl' in fields) fields.baseUrl = normaliseBaseUrl(fields.baseUrl);

	const credentials: Record<string, string> = { ...fields, ...input.extra, authSource: input.source };

	// Verify first. A credential that cannot say who it belongs to is not one
	// worth storing, and the error is far more useful here than on first use.
	const viewer = await adapter.viewer(credentials);
	credentials.login = viewer.login;

	let account: IntegrationAccountInfo;
	if (input.accountId) {
		const existing = integrationAccountQueries.getById(input.accountId);
		if (!existing) throw new Error('That account is no longer connected');
		if (existing.provider !== input.provider) throw new Error('That account belongs to another service');
		forgetCachedCliToken(existing.id);
		forgetOwners(existing.id);
		// A field the new method does not set must not survive from the old one,
		// so the method's keys are cleared before the new ones are merged in.
		account = integrationAccounts.updateCredentials(existing.id, credentials, {
			authMethod: input.authMethod,
			replace: METHOD_KEYS
		});
		debug.log('git-hosts', `Reconnected ${input.provider} account "${account.label}" via ${input.source}`);
	} else {
		account = integrationAccounts.connect({
			provider: input.provider,
			label: input.label?.trim() || labelFor(provider.name, viewer.login, input.provider),
			projectId: input.projectId ?? null,
			credentials,
			capabilities: input.capabilities,
			authMethod: input.authMethod
		});
		debug.log('git-hosts', `Connected ${input.provider} account "${account.label}" via ${input.source}`);
	}

	integrationAccounts.setStatus(account.id, 'ok', `Signed in as ${viewer.login}`);

	// Warm the owner list in the background: it is what lets a second account
	// on the same host be matched to a remote by organisation.
	void adapter
		.listOwners(credentials)
		.then((owners) => rememberOwners(account.id, owners.map((owner) => owner.login)))
		.catch(() => {});

	return { account: integrationAccounts.get(account.id) ?? account, viewer };
}
