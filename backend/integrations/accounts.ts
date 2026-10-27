/**
 * The account service — connect, reconfigure, disconnect.
 *
 * Every mutation ends in `reproject()`, so a surface row can never drift from
 * the account it was derived from. Credential VALUES never leave this module:
 * what the hub receives is which fields are set, never what they are set to.
 */

import {
	integrationAccountQueries,
	integrationProjectionQueries,
	type IntegrationAccountRow
} from '$backend/database/queries';
import type {
	IntegrationAccountInfo,
	IntegrationCapability,
	IntegrationStatus
} from '$shared/types/integrations';
import { defaultCapabilitiesOf, getProvider, type IntegrationProvider } from './registry';
import { randomBytes } from 'crypto';
import { reproject, releaseAll } from './projections';
import { debug } from '$shared/utils/logger';

/**
 * Told after any account is connected, reconfigured, toggled, rebound or
 * disconnected — with the id, which may no longer exist.
 *
 * Projections cover surfaces whose state is a ROW. A surface whose state is a
 * live connection instead (a chat channel's bot, held open by the backend)
 * has nothing to project and needs to know when to reconnect; this is how.
 * Listeners must be cheap and must not throw — they run inside the mutation.
 */
export type AccountsChangedListener = (accountId: string) => void;

const changeListeners = new Set<AccountsChangedListener>();

export function onAccountsChanged(listener: AccountsChangedListener): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

function notifyChanged(accountId: string): void {
	for (const listener of changeListeners) {
		try {
			listener(accountId);
		} catch (error) {
			debug.error('integrations', 'Account change listener failed:', error);
		}
	}
}

/**
 * Fill every credential the provider mints itself. 32 random bytes in
 * base64url fits every secret alphabet seen so far — Telegram's secret token
 * allows only `A-Za-z0-9_-`, up to 256 characters.
 */
export function withGeneratedCredentials(
	provider: IntegrationProvider,
	credentials: Record<string, string>
): Record<string, string> {
	const filled = { ...credentials };
	for (const field of provider.generatedCredentials ?? []) {
		if (!(filled[field] ?? '').trim()) filled[field] = randomBytes(32).toString('base64url');
	}
	return filled;
}

export interface ConnectInput {
	provider: string;
	label?: string;
	projectId?: string | null;
	credentials: Record<string, string>;
	capabilities?: IntegrationCapability[];
}

function requireProvider(id: string): IntegrationProvider {
	const provider = getProvider(id);
	if (!provider) throw new Error(`Unknown integration provider "${id}"`);
	return provider;
}

/**
 * Reject a connect that is missing a required field.
 *
 * Done before the row is written rather than at first use: an account saved
 * without its key looks connected in the hub and fails much later, somewhere
 * with no useful place to report it.
 */
function assertRequiredFields(provider: IntegrationProvider, credentials: Record<string, string>): void {
	const missing = provider.credentialFields
		.filter((field) => field.isRequired && !(credentials[field.name] ?? '').trim())
		.map((field) => field.label);

	if (missing.length > 0) {
		throw new Error(`${provider.name} needs ${missing.join(', ')}`);
	}
}

function stripGenerated(provider: IntegrationProvider, credentials: Record<string, string>): Record<string, string> {
	const generated = new Set(provider.generatedCredentials ?? []);
	return Object.fromEntries(Object.entries(credentials).filter(([field]) => !generated.has(field)));
}

function assertKnownCapabilities(provider: IntegrationProvider, capabilities: IntegrationCapability[]): void {
	const unknown = capabilities.filter((capability) => !provider.capabilities.includes(capability));
	if (unknown.length > 0) {
		throw new Error(`${provider.name} does not offer: ${unknown.join(', ')}`);
	}
}

/**
 * A label the user did not have to invent.
 *
 * `(provider, label)` is the identity, so a second account for the same
 * provider needs a distinct one — "Firecrawl 2" is a better default than an
 * error telling the user to think of a name.
 */
function defaultLabel(provider: IntegrationProvider): string {
	const taken = new Set(integrationAccountQueries.getByProvider(provider.id).map((row) => row.label));
	if (!taken.has(provider.name)) return provider.name;
	for (let n = 2; ; n += 1) {
		const candidate = `${provider.name} ${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Which credential fields hold a value. The values themselves stay here. */
function configuredFieldsOf(provider: IntegrationProvider, credentials: Record<string, string>): string[] {
	return provider.credentialFields
		.filter((field) => (credentials[field.name] ?? '').trim().length > 0)
		.map((field) => field.name);
}

export function toAccountInfo(row: IntegrationAccountRow): IntegrationAccountInfo {
	const provider = getProvider(row.provider);
	const credentials = integrationAccountQueries.credentialsOf(row);

	return {
		id: row.id,
		provider: row.provider,
		label: row.label,
		projectId: row.project_id,
		authMethod: row.auth_method,
		configuredFields: provider ? configuredFieldsOf(provider, credentials) : Object.keys(credentials),
		capabilities: integrationAccountQueries.capabilitiesOf(row),
		status: row.status,
		statusDetail: row.status_detail,
		checkedAt: row.checked_at,
		isEnabled: row.is_enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		projections: integrationProjectionQueries.getForAccount(row.id).map((projection) => ({
			capability: projection.capability,
			targetKind: projection.target_kind,
			targetId: projection.target_id,
			adopted: projection.adopted === 1
		}))
	};
}

export const integrationAccounts = {
	list(): IntegrationAccountInfo[] {
		return integrationAccountQueries.getAll().map(toAccountInfo);
	},

	get(id: string): IntegrationAccountInfo | null {
		const row = integrationAccountQueries.getById(id);
		return row ? toAccountInfo(row) : null;
	},

	connect(input: ConnectInput): IntegrationAccountInfo {
		const provider = requireProvider(input.provider);
		assertRequiredFields(provider, input.credentials);

		const capabilities = input.capabilities ?? [...defaultCapabilitiesOf(provider)];
		assertKnownCapabilities(provider, capabilities);

		const row = integrationAccountQueries.create({
			provider: provider.id,
			label: (input.label ?? '').trim() || defaultLabel(provider),
			projectId: input.projectId ?? null,
			authMethod: provider.authMethod,
			// Generated fields are Clopen's, not the form's: whatever a client sent
			// for one is dropped rather than trusted as a secret.
			credentials: withGeneratedCredentials(provider, stripGenerated(provider, input.credentials)),
			capabilities
		});

		try {
			reproject(row.id);
		} catch (error) {
			// A projection that cannot be made means the account is not usable, and
			// a half-connected account is worse than none: it shows as connected in
			// the hub while nothing behind it works.
			integrationAccountQueries.remove(row.id);
			throw error;
		}

		debug.log('integrations', `Connected ${provider.id} account "${row.label}"`);
		notifyChanged(row.id);
		return this.get(row.id)!;
	},

	/**
	 * Merge new credential values in.
	 *
	 * An empty value means "the form did not re-send this field", not "clear
	 * it" — the same rule the db-client and SSH forms follow, and the reason
	 * editing a label does not wipe a token.
	 */
	updateCredentials(id: string, patch: Record<string, string>): IntegrationAccountInfo {
		const row = integrationAccountQueries.getById(id);
		if (!row) throw new Error('Integration account not found');
		const provider = requireProvider(row.provider);

		const merged = { ...integrationAccountQueries.credentialsOf(row) };
		for (const [field, value] of Object.entries(stripGenerated(provider, patch))) {
			if (value === '') continue;
			merged[field] = value;
		}
		assertRequiredFields(provider, merged);

		integrationAccountQueries.setCredentials(id, withGeneratedCredentials(provider, merged));
		integrationAccountQueries.setStatus(id, 'unknown', null);
		reproject(id);
		notifyChanged(id);
		return this.get(id)!;
	},

	/** Rename. The label is how a user tells two accounts of one service apart. */
	setLabel(id: string, label: string): IntegrationAccountInfo {
		const row = integrationAccountQueries.getById(id);
		if (!row) throw new Error('Integration account not found');

		const trimmed = label.trim();
		if (!trimmed) throw new Error('A name is required');

		const taken = integrationAccountQueries
			.getByProvider(row.provider)
			.some((other) => other.id !== id && other.label === trimmed);
		if (taken) throw new Error(`Another ${row.provider} account is already called "${trimmed}"`);

		integrationAccountQueries.setLabel(id, trimmed);
		return this.get(id)!;
	},

	setCapabilities(id: string, capabilities: IntegrationCapability[]): IntegrationAccountInfo {
		const row = integrationAccountQueries.getById(id);
		if (!row) throw new Error('Integration account not found');
		assertKnownCapabilities(requireProvider(row.provider), capabilities);

		integrationAccountQueries.setCapabilities(id, capabilities);
		reproject(id);
		notifyChanged(id);
		return this.get(id)!;
	},

	setEnabled(id: string, enabled: boolean): IntegrationAccountInfo {
		if (!integrationAccountQueries.getById(id)) throw new Error('Integration account not found');
		integrationAccountQueries.setEnabled(id, enabled);
		reproject(id);
		notifyChanged(id);
		return this.get(id)!;
	},

	setProject(id: string, projectId: string | null): IntegrationAccountInfo {
		if (!integrationAccountQueries.getById(id)) throw new Error('Integration account not found');
		integrationAccountQueries.setProject(id, projectId);
		reproject(id);
		notifyChanged(id);
		return this.get(id)!;
	},

	setStatus(id: string, status: IntegrationStatus, detail: string | null): void {
		integrationAccountQueries.setStatus(id, status, detail);
	},

	/** Release every derived row, then drop the account. Order matters. */
	disconnect(id: string): void {
		const row = integrationAccountQueries.getById(id);
		if (!row) return;
		releaseAll(id);
		integrationAccountQueries.remove(id);
		debug.log('integrations', `Disconnected ${row.provider} account "${row.label}"`);
		notifyChanged(id);
	}
};
