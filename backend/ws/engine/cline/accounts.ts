/**
 * Cline Account Management Handlers
 *
 * Cline is multi-provider (Anthropic, OpenAI, Google, the Cline account, …).
 *
 *   - **API-key** providers: a simple all-fields-at-once form (`…-accounts-save`)
 *     that writes `{ provider, authMethod: 'api_key', apiKey, baseUrl?, fields? }`.
 *   - **OAuth** providers (the Cline account, Claude sign-in, …): an event-driven
 *     flow (`…-account-login-start`) driven by the SDK's provider auth handler.
 *     The handler owns its own local callback server; Clopen relays the auth URL
 *     and any interactive prompts to the client over WS (mirroring Pi's login).
 *     The returned OAuth credentials are stored as
 *     `{ provider, authMethod: 'oauth', oauth: { access, refresh, expires, … } }`.
 *
 * Every account's `engine_accounts.credential` is a JSON wrapper (see
 * `backend/engine/adapters/cline/credential.ts`).
 */

import { t } from 'elysia';
import { getProviderAuthHandler, isOAuthProvider } from '@cline/sdk';
import type { OAuthLoginCallbacks, OAuthPrompt, OAuthCredentials } from '@cline/sdk';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';
import { getClineProviderFields } from '../../../engine/adapters/cline/presets';
import {
	getClineProvider,
	parseClineCredential,
	serializeClineCredential,
	type ClineCredential,
} from '../../../engine/adapters/cline/credential';
import { requireSetupSessionAccess } from '../access';
import { debug } from '$shared/utils/logger';

async function disposeClineEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('cline');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

// ── Interactive OAuth login sessions ──

interface ClineLoginSession {
	userId: string;
	disposed: boolean;
	name: string;
	provider: string;
	/** When set, re-authenticate this existing account in place instead of creating one. */
	reauthAccountId: number | null;
	pendingPrompt: { resolve: (value: string) => void; reject: (error: Error) => void } | null;
	timer: ReturnType<typeof setTimeout>;
}

const loginSessions = new Map<string, ClineLoginSession>();
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function cleanupLogin(loginId: string): void {
	const entry = loginSessions.get(loginId);
	if (!entry || entry.disposed) return;
	entry.disposed = true;
	clearTimeout(entry.timer);
	entry.pendingPrompt?.reject(new Error('Login session closed'));
	entry.pendingPrompt = null;
	loginSessions.delete(loginId);
}

export const clineAccountsHandler = createRouter()

	// ═══ CRUD ═══

	.http('engine:cline-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String(),
				provider: t.String(),
				authMethod: t.Union([t.Literal('api_key'), t.Literal('oauth')]),
				/** Non-secret provider-scoped fields (base url, region, …) for edit prefill. */
				fields: t.Record(t.String(), t.String()),
			})),
		})
	}, async () => {
		const provider = getClineProvider();
		if (!provider) return { accounts: [] };
		const accounts = engineQueries.getAccountsByProvider(provider.id);
		return {
			accounts: accounts
				.map(a => {
					const parsed = parseClineCredential(a.credential);
					if (!parsed) return null;
					const fields: Record<string, string> = { ...(parsed.fields ?? {}) };
					if (parsed.baseUrl) fields.baseUrl = parsed.baseUrl;
					return {
						id: a.id,
						name: a.name,
						isActive: a.is_active === 1,
						createdAt: a.created_at,
						provider: parsed.provider,
						authMethod: parsed.authMethod,
						fields,
					};
				})
				.filter((x): x is NonNullable<typeof x> => x !== null),
		};
	})

	// Add or edit an API-key account from an all-fields-at-once form. A blank
	// secret field on edit keeps the stored value; blank fields keep theirs.
	.http('engine:cline-accounts-save', {
		data: t.Object({
			accountId: t.Optional(t.Number()),
			name: t.String({ minLength: 1 }),
			provider: t.String({ minLength: 1 }),
			values: t.Record(t.String(), t.String()),
		}),
		response: t.Object({ success: t.Boolean(), accountId: t.Number() })
	}, async ({ data }) => {
		const providerRow = getClineProvider();
		if (!providerRow) throw new Error('Cline provider not found in database');

		const fieldDefs = getClineProviderFields(data.provider);
		const keyField = fieldDefs.find(f => f.role === 'apiKey');
		const baseUrlField = fieldDefs.find(f => f.role === 'baseUrl');
		const extraFields = fieldDefs.filter(f => f.role === 'field');

		const existing = data.accountId != null
			? parseClineCredential(engineQueries.getAccount(data.accountId)?.credential)
			: null;

		const providedKey = keyField ? (data.values[keyField.key] ?? '').trim() : '';
		const apiKey = providedKey || existing?.apiKey || '';
		if (!apiKey) throw new Error('API key is required');

		const providedBaseUrl = baseUrlField ? (data.values[baseUrlField.key] ?? '').trim() : '';
		const baseUrl = providedBaseUrl || existing?.baseUrl;

		const fields: Record<string, string> = { ...(existing?.fields ?? {}) };
		for (const field of extraFields) {
			const value = (data.values[field.key] ?? '').trim();
			if (value) fields[field.key] = value;
		}

		const credential: ClineCredential = {
			provider: data.provider,
			authMethod: 'api_key',
			apiKey,
			...(baseUrl ? { baseUrl } : {}),
			...(Object.keys(fields).length ? { fields } : {}),
		};
		const serialized = serializeClineCredential(credential);

		let accountId: number;
		if (data.accountId != null && engineQueries.getAccount(data.accountId)) {
			engineQueries.updateAccountCredential(data.accountId, serialized);
			engineQueries.renameAccount(data.accountId, data.name.trim());
			accountId = data.accountId;
		} else {
			accountId = engineQueries.createAccount(providerRow.id, data.name.trim(), serialized).id;
		}
		await disposeClineEngines();
		return { success: true, accountId };
	})

	.http('engine:cline-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.id);
		await disposeClineEngines();
		return { success: true };
	})

	.http('engine:cline-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('cline');
		engineQueries.deleteAccount(data.id);
		if (active?.id === data.id) await disposeClineEngines();
		return { success: true };
	})

	.http('engine:cline-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// ═══ OAuth login (event-driven) ═══

	.on('engine:cline-account-login-start', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			provider: t.String({ minLength: 1 }),
			reauthAccountId: t.Optional(t.Number()),
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const loginId = crypto.randomUUID();

		const handler = getProviderAuthHandler(data.provider);
		if (!handler || !isOAuthProvider(data.provider)) {
			ws.emit.user(userId, 'engine:cline-account-login-error', { loginId, message: `Provider "${data.provider}" does not support OAuth sign-in.` });
			return;
		}

		const entry: ClineLoginSession = {
			userId, disposed: false,
			name: data.name.trim(), provider: data.provider,
			reauthAccountId: data.reauthAccountId ?? null,
			pendingPrompt: null,
			timer: setTimeout(() => {
				ws.emit.user(userId, 'engine:cline-account-login-error', { loginId, message: 'Login timed out after 15 minutes' });
				cleanupLogin(loginId);
			}, LOGIN_TIMEOUT_MS),
		};
		loginSessions.set(loginId, entry);
		ws.emit.user(userId, 'engine:cline-account-login-started', { loginId });

		const awaitPrompt = (message: string): Promise<string> =>
			new Promise<string>((resolve, reject) => {
				entry.pendingPrompt = { resolve, reject };
				ws.emit.user(userId, 'engine:cline-account-login-prompt', { loginId, message });
			});

		const callbacks: OAuthLoginCallbacks = {
			onAuth: (info: { url: string; instructions?: string }) => {
				ws.emit.user(userId, 'engine:cline-account-login-event', {
					loginId, kind: 'auth_url', message: info.instructions, url: info.url,
				});
			},
			onPrompt: (prompt: OAuthPrompt) => awaitPrompt(prompt.message),
			onProgress: (message: string) => {
				ws.emit.user(userId, 'engine:cline-account-login-event', { loginId, kind: 'progress', message });
			},
			onManualCodeInput: () => awaitPrompt('Paste the authorization code from your browser:'),
		};

		try {
			const credential = (await handler.login({ callbacks })) as OAuthCredentials;
			if (entry.disposed) return;

			const serialized = serializeClineCredential({ provider: data.provider, authMethod: 'oauth', oauth: credential });
			let accountId: number;
			if (entry.reauthAccountId != null && engineQueries.getAccount(entry.reauthAccountId)) {
				engineQueries.updateAccountCredential(entry.reauthAccountId, serialized);
				engineQueries.renameAccount(entry.reauthAccountId, entry.name);
				accountId = entry.reauthAccountId;
			} else {
				const providerRow = getClineProvider();
				if (!providerRow) throw new Error('Cline provider not found in database');
				accountId = engineQueries.createAccount(providerRow.id, entry.name, serialized).id;
			}
			await disposeClineEngines();

			ws.emit.user(userId, 'engine:cline-account-login-complete', { loginId, accountId });
			cleanupLogin(loginId);
		} catch (error) {
			if (!entry.disposed) {
				debug.warn('engine', `Cline login failed: ${error instanceof Error ? error.message : String(error)}`);
				ws.emit.user(userId, 'engine:cline-account-login-error', {
					loginId,
					message: error instanceof Error ? error.message : 'Login failed',
				});
			}
			cleanupLogin(loginId);
		}
	})

	.on('engine:cline-account-login-submit', {
		data: t.Object({ loginId: t.String(), value: t.String() })
	}, async ({ data, conn }) => {
		let entry: ClineLoginSession;
		try {
			entry = requireSetupSessionAccess(conn, data.loginId, loginSessions);
		} catch {
			return;
		}
		const pending = entry.pendingPrompt;
		entry.pendingPrompt = null;
		pending?.resolve(data.value);
	})

	.on('engine:cline-account-login-cancel', {
		data: t.Object({ loginId: t.String() })
	}, async ({ data, conn }) => {
		try {
			requireSetupSessionAccess(conn, data.loginId, loginSessions);
		} catch {
			return;
		}
		cleanupLogin(data.loginId);
	})

	// ═══ Event declarations (Server → Client) ═══

	.emit('engine:cline-account-login-started', t.Object({ loginId: t.String() }))
	.emit('engine:cline-account-login-event', t.Object({
		loginId: t.String(),
		kind: t.String(),
		message: t.Optional(t.String()),
		url: t.Optional(t.String()),
	}))
	.emit('engine:cline-account-login-prompt', t.Object({
		loginId: t.String(),
		message: t.String(),
	}))
	.emit('engine:cline-account-login-complete', t.Object({ loginId: t.String(), accountId: t.Number() }))
	.emit('engine:cline-account-login-error', t.Object({ loginId: t.String(), message: t.String() }));
