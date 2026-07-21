/**
 * Cursor Account Management Handlers
 *
 * Auth model: API-key only. The user pastes a Cursor API key (user key from the
 * dashboard, or a team service-account key); no PTY / device flow. The key is
 * validated with `Cursor.me({ apiKey })` before it is stored as a JSON credential
 * (`{ "apiKey": "…" }`) on engine_accounts under provider slug 'cursor'.
 *
 * Switching/deleting the active account disposes the project-scoped CursorEngine
 * instances so the next stream picks up the new credential.
 */

import { t } from 'elysia';
import { Cursor } from '@cursor/sdk';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';
import { serializeCursorCredential } from '../../../engine/adapters/cursor/credential';
import { debug } from '$shared/utils/logger';

async function disposeCursorEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('cursor');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

/**
 * Validate an API key by resolving the authenticated user. Only a genuine
 * authentication failure (401 / `AuthenticationError`) means the key is bad —
 * `Cursor.me()` also 403s with `plan_required` for free-tier keys (which are
 * perfectly valid), and transient network errors shouldn't block saving a
 * working key. So we reject ONLY on an auth error and accept everything else.
 */
async function validateApiKey(apiKey: string): Promise<void> {
	try {
		await Cursor.me({ apiKey });
	} catch (error) {
		const status = (error as { status?: number })?.status;
		const name = (error as Error)?.name;
		if (name === 'AuthenticationError' || status === 401) {
			throw new Error('Invalid Cursor API key. Check the key from cursor.com/dashboard and try again.');
		}
		debug.warn('engine', `Cursor key validation non-fatal (${name ?? 'error'} ${status ?? ''}) — accepting key`);
	}
}

export const cursorAccountsHandler = createRouter()

	.http('engine:cursor-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String()
			}))
		})
	}, async () => {
		const provider = engineQueries.getProviderBySlug('cursor', 'cursor');
		if (!provider) return { accounts: [] };
		const accounts = engineQueries.getAccountsByProvider(provider.id);
		return {
			accounts: accounts.map(a => ({
				id: a.id,
				name: a.name,
				isActive: a.is_active === 1,
				createdAt: a.created_at
			}))
		};
	})

	.http('engine:cursor-accounts-add', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			apiKey: t.String({ minLength: 1 })
		}),
		response: t.Object({
			account: t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String()
			})
		})
	}, async ({ data }) => {
		const provider = engineQueries.getProviderBySlug('cursor', 'cursor');
		if (!provider) {
			throw new Error('Cursor provider not found in database');
		}

		const apiKey = data.apiKey.trim();
		await validateApiKey(apiKey);

		const account = engineQueries.createAccount(provider.id, data.name.trim(), serializeCursorCredential({ apiKey }));

		if (account.is_active === 1) {
			await disposeCursorEngines();
		}

		return {
			account: {
				id: account.id,
				name: account.name,
				isActive: account.is_active === 1,
				createdAt: account.created_at
			}
		};
	})

	.http('engine:cursor-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.id);
		await disposeCursorEngines();
		return { success: true };
	})

	.http('engine:cursor-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('cursor');
		engineQueries.deleteAccount(data.id);
		if (active?.id === data.id) await disposeCursorEngines();
		return { success: true };
	})

	.http('engine:cursor-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// Replace the stored API key for an account. When the edited account is the
	// active one, drop engine instances so the next stream picks up the key.
	.http('engine:cursor-accounts-update-key', {
		data: t.Object({ id: t.Number(), apiKey: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const apiKey = data.apiKey.trim();
		await validateApiKey(apiKey);
		engineQueries.updateAccountCredential(data.id, serializeCursorCredential({ apiKey }));
		const active = engineQueries.getActiveAccountForEngine('cursor');
		if (active?.id === data.id) await disposeCursorEngines();
		return { success: true };
	})

	// Restart all Cursor engine instances so subsequent models:list / chat calls
	// re-initialise with fresh credentials.
	.http('engine:cursor-restart', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async () => {
		await disposeCursorEngines();
		return { success: true };
	});
