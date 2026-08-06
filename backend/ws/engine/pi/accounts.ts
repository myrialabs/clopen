/**
 * Pi Account Management Handlers
 *
 * Pi is multi-provider (Anthropic, OpenAI, Google, …). BOTH API-key and OAuth
 * auth go through the SAME event-driven flow, `ModelRuntime.login(provider,
 * type, interaction)` — the provider owns its prompts, so it can ask for exactly
 * what it needs (e.g. Cloudflare wants an account ID + key, not just a key). The
 * interaction's `notify`/`prompt` callbacks are relayed to the client over WS;
 * the client answers prompts via `engine:pi-account-login-submit`. Passing
 * `reauthAccountId` re-authenticates an existing account in place.
 *
 * Every account's `engine_accounts.credential` stores a JSON wrapper
 * `{ provider, credential }` (see `backend/engine/adapters/pi/credential.ts`).
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential } from '@earendil-works/pi-ai';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';
import { createPiRuntime, getPiProviderFields } from '../../../engine/adapters/pi/presets';
import { DbCredentialStore, serializePiCredential, parsePiCredential, getPiProvider } from '../../../engine/adapters/pi/credential';
import { requireSetupSessionAccess } from '../access';
import { debug } from '$shared/utils/logger';

async function disposePiEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('pi');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

// ── Interactive login sessions ──

interface PiLoginSession {
	userId: string;
	disposed: boolean;
	controller: AbortController;
	name: string;
	provider: string;
	/** When set, re-authenticate this existing account in place instead of creating one. */
	reauthAccountId: number | null;
	pendingPrompt: { resolve: (value: string) => void; reject: (error: Error) => void } | null;
	timer: ReturnType<typeof setTimeout>;
}

const loginSessions = new Map<string, PiLoginSession>();
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function cleanupLogin(loginId: string): void {
	const entry = loginSessions.get(loginId);
	if (!entry || entry.disposed) return;
	entry.disposed = true;
	clearTimeout(entry.timer);
	entry.pendingPrompt?.reject(new Error('Login session closed'));
	entry.pendingPrompt = null;
	if (!entry.controller.signal.aborted) entry.controller.abort();
	loginSessions.delete(loginId);
}

export const piAccountsHandler = createRouter()

	// ═══ CRUD ═══

	.http('engine:pi-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String(),
				provider: t.String(),
				authType: t.Union([t.Literal('api_key'), t.Literal('oauth')]),
				/** Non-secret provider-scoped config (account id, base url, …) for edit prefill. */
				env: t.Record(t.String(), t.String()),
			})),
		})
	}, async () => {
		const provider = getPiProvider();
		if (!provider) return { accounts: [] };
		const accounts = engineQueries.getAccountsByProvider(provider.id);
		return {
			accounts: accounts
				.map(a => {
					const parsed = parsePiCredential(a.credential);
					if (!parsed) return null;
					const env = parsed.credential.type === 'api_key' ? (parsed.credential.env ?? {}) : {};
					return {
						id: a.id,
						name: a.name,
						isActive: a.is_active === 1,
						createdAt: a.created_at,
						provider: parsed.provider,
						authType: parsed.credential.type,
						env,
					};
				})
				.filter((x): x is NonNullable<typeof x> => x !== null),
		};
	})

	// Add or edit an API-key account from an all-fields-at-once form. A blank
	// secret field on edit keeps the stored value; blank env fields keep theirs.
	.http('engine:pi-accounts-save', {
		data: t.Object({
			accountId: t.Optional(t.Number()),
			name: t.String({ minLength: 1 }),
			provider: t.String({ minLength: 1 }),
			values: t.Record(t.String(), t.String()),
		}),
		response: t.Object({ success: t.Boolean(), accountId: t.Number() })
	}, async ({ data }) => {
		const providerRow = getPiProvider();
		if (!providerRow) throw new Error('Pi provider not found in database');

		const fields = getPiProviderFields(data.provider);
		const keyField = fields.find(f => f.role === 'key');
		const envFields = fields.filter(f => f.role === 'env');

		const existing = data.accountId != null
			? parsePiCredential(engineQueries.getAccount(data.accountId)?.credential)
			: null;
		const existingApiKey = existing?.credential.type === 'api_key' ? existing.credential : null;

		const providedKey = keyField ? (data.values[keyField.key] ?? '').trim() : '';
		const key = providedKey || existingApiKey?.key || '';
		if (!key) throw new Error('API key is required');

		const env: Record<string, string> = { ...(existingApiKey?.env ?? {}) };
		for (const field of envFields) {
			const value = (data.values[field.key] ?? '').trim();
			if (value) env[field.key] = value;
		}

		const credential: Credential = { type: 'api_key', key, ...(Object.keys(env).length ? { env } : {}) };
		const serialized = serializePiCredential({ provider: data.provider, credential });

		let accountId: number;
		if (data.accountId != null && engineQueries.getAccount(data.accountId)) {
			engineQueries.updateAccountCredential(data.accountId, serialized);
			engineQueries.renameAccount(data.accountId, data.name.trim());
			accountId = data.accountId;
		} else {
			accountId = engineQueries.createAccount(providerRow.id, data.name.trim(), serialized).id;
		}
		await disposePiEngines();
		return { success: true, accountId };
	})

	.http('engine:pi-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.id);
		await disposePiEngines();
		return { success: true };
	})

	.http('engine:pi-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('pi');
		engineQueries.deleteAccount(data.id);
		if (active?.id === data.id) await disposePiEngines();
		return { success: true };
	})

	.http('engine:pi-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// ═══ Interactive / OAuth login (event-driven) ═══

	.on('engine:pi-account-login-start', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			provider: t.String({ minLength: 1 }),
			type: t.Union([t.Literal('api_key'), t.Literal('oauth')]),
			reauthAccountId: t.Optional(t.Number()),
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const loginId = crypto.randomUUID();
		const controller = new AbortController();

		const entry: PiLoginSession = {
			userId, disposed: false, controller,
			name: data.name.trim(), provider: data.provider,
			reauthAccountId: data.reauthAccountId ?? null,
			pendingPrompt: null,
			timer: setTimeout(() => {
				ws.emit.user(userId, 'engine:pi-account-login-error', { loginId, message: 'Login timed out after 15 minutes' });
				cleanupLogin(loginId);
			}, LOGIN_TIMEOUT_MS),
		};
		loginSessions.set(loginId, entry);
		ws.emit.user(userId, 'engine:pi-account-login-started', { loginId });

		const interaction: AuthInteraction = {
			signal: controller.signal,
			notify: (event: AuthEvent) => {
				ws.emit.user(userId, 'engine:pi-account-login-event', {
					loginId,
					kind: event.type,
					message: 'message' in event ? event.message : undefined,
					url: event.type === 'auth_url' ? event.url : undefined,
					instructions: event.type === 'auth_url' ? event.instructions : undefined,
					userCode: event.type === 'device_code' ? event.userCode : undefined,
					verificationUri: event.type === 'device_code' ? event.verificationUri : undefined,
				});
			},
			prompt: (prompt: AuthPrompt) => {
				return new Promise<string>((resolve, reject) => {
					entry.pendingPrompt = { resolve, reject };
					ws.emit.user(userId, 'engine:pi-account-login-prompt', {
						loginId,
						kind: prompt.type,
						message: prompt.message,
						placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
						options: prompt.type === 'select'
							? prompt.options.map(o => ({ id: o.id, label: o.label, description: o.description }))
							: undefined,
					});
				});
			},
		};

		try {
			const runtime = await createPiRuntime(new DbCredentialStore([]));
			const credential = await runtime.login(data.provider, data.type as AuthType, interaction);
			if (entry.disposed) return;

			const serialized = serializePiCredential({ provider: data.provider, credential });
			let accountId: number;
			if (entry.reauthAccountId != null && engineQueries.getAccount(entry.reauthAccountId)) {
				// Re-authenticate in place — update the credential (and name) of the
				// existing account rather than creating a duplicate.
				engineQueries.updateAccountCredential(entry.reauthAccountId, serialized);
				engineQueries.renameAccount(entry.reauthAccountId, entry.name);
				accountId = entry.reauthAccountId;
			} else {
				const providerRow = getPiProvider();
				if (!providerRow) throw new Error('Pi provider not found in database');
				accountId = engineQueries.createAccount(providerRow.id, entry.name, serialized).id;
			}
			await disposePiEngines();

			ws.emit.user(userId, 'engine:pi-account-login-complete', { loginId, accountId });
			cleanupLogin(loginId);
		} catch (error) {
			if (!entry.disposed) {
				debug.warn('engine', `Pi login failed: ${error instanceof Error ? error.message : String(error)}`);
				ws.emit.user(userId, 'engine:pi-account-login-error', {
					loginId,
					message: error instanceof Error ? error.message : 'Login failed',
				});
			}
			cleanupLogin(loginId);
		}
	})

	.on('engine:pi-account-login-submit', {
		data: t.Object({ loginId: t.String(), value: t.String() })
	}, async ({ data, conn }) => {
		let entry: PiLoginSession;
		try {
			entry = requireSetupSessionAccess(conn, data.loginId, loginSessions);
		} catch {
			return;
		}
		const pending = entry.pendingPrompt;
		entry.pendingPrompt = null;
		pending?.resolve(data.value);
	})

	.on('engine:pi-account-login-cancel', {
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

	.emit('engine:pi-account-login-started', t.Object({ loginId: t.String() }))
	.emit('engine:pi-account-login-event', t.Object({
		loginId: t.String(),
		kind: t.String(),
		message: t.Optional(t.String()),
		url: t.Optional(t.String()),
		instructions: t.Optional(t.String()),
		userCode: t.Optional(t.String()),
		verificationUri: t.Optional(t.String()),
	}))
	.emit('engine:pi-account-login-prompt', t.Object({
		loginId: t.String(),
		kind: t.String(),
		message: t.String(),
		placeholder: t.Optional(t.String()),
		options: t.Optional(t.Array(t.Object({
			id: t.String(),
			label: t.String(),
			description: t.Optional(t.String()),
		}))),
	}))
	.emit('engine:pi-account-login-complete', t.Object({ loginId: t.String(), accountId: t.Number() }))
	.emit('engine:pi-account-login-error', t.Object({ loginId: t.String(), message: t.String() }));
