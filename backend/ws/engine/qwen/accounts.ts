/**
 * Qwen Code Account Management Handlers
 *
 * Auth model: paste-token, per-account. Each `engine_accounts.credential`
 * stores a JSON blob of `{ apiKey, preset }`. The chosen preset (DashScope
 * CN/INTL, OpenRouter, Fireworks) decides the base URL — we no longer offer
 * a custom-endpoint escape hatch since every account stands alone.
 *
 * Switching/deleting active accounts disposes the project-scoped Qwen engine
 * instances so the next stream picks up the new credential.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';
import {
	parseQwenCredential,
	serializeQwenCredential,
} from '../../../engine/adapters/qwen/credential';
import type { QwenProviderPresetId } from '../../../engine/adapters/qwen/presets';

const PRESET_LITERALS = t.Union([
	t.Literal('dashscope-cn'),
	t.Literal('dashscope-intl'),
	t.Literal('openrouter'),
	t.Literal('fireworks'),
]);

async function disposeQwenEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('qwen');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

export const qwenAccountsHandler = createRouter()

	.http('engine:qwen-accounts-list', {
		data: t.Object({}),
		response: t.Object({
			accounts: t.Array(t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String(),
				preset: PRESET_LITERALS,
			})),
		})
	}, async () => {
		const provider = engineQueries.getProviderBySlug('qwen', 'qwen');
		if (!provider) return { accounts: [] };
		const accounts = engineQueries.getAccountsByProvider(provider.id);
		return {
			accounts: accounts.map(a => {
				const credential = parseQwenCredential(a.credential);
				return {
					id: a.id,
					name: a.name,
					isActive: a.is_active === 1,
					createdAt: a.created_at,
					preset: credential.preset as QwenProviderPresetId,
				};
			}),
		};
	})

	.http('engine:qwen-accounts-add', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			apiKey: t.String({ minLength: 1 }),
			preset: PRESET_LITERALS,
		}),
		response: t.Object({
			account: t.Object({
				id: t.Number(),
				name: t.String(),
				isActive: t.Boolean(),
				createdAt: t.String(),
				preset: PRESET_LITERALS,
			})
		})
	}, async ({ data }) => {
		const provider = engineQueries.getProviderBySlug('qwen', 'qwen');
		if (!provider) {
			throw new Error('Qwen Code provider not found in database');
		}

		const credential = serializeQwenCredential({
			apiKey: data.apiKey.trim(),
			preset: data.preset,
		});

		const account = engineQueries.createAccount(provider.id, data.name.trim(), credential);

		if (account.is_active === 1) {
			await disposeQwenEngines();
		}

		return {
			account: {
				id: account.id,
				name: account.name,
				isActive: account.is_active === 1,
				createdAt: account.created_at,
				preset: data.preset,
			}
		};
	})

	.http('engine:qwen-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.id);
		await disposeQwenEngines();
		return { success: true };
	})

	.http('engine:qwen-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('qwen');
		engineQueries.deleteAccount(data.id);
		if (active?.id === data.id) await disposeQwenEngines();
		return { success: true };
	})

	.http('engine:qwen-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// Update an account's API key and/or preset. Both are optional — an omitted
	// (or blank) apiKey keeps the stored one, so the user can re-point the
	// preset without re-entering the secret, and vice versa.
	.http('engine:qwen-accounts-update', {
		data: t.Object({
			id: t.Number(),
			apiKey: t.Optional(t.String()),
			preset: t.Optional(PRESET_LITERALS),
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const account = engineQueries.getAccount(data.id);
		if (!account) throw new Error('Account not found');
		const current = parseQwenCredential(account.credential);
		const apiKey = data.apiKey?.trim() ? data.apiKey.trim() : current.apiKey;
		const preset = data.preset ?? current.preset;
		engineQueries.updateAccountCredential(data.id, serializeQwenCredential({ apiKey, preset }));
		const active = engineQueries.getActiveAccountForEngine('qwen');
		if (active?.id === data.id) await disposeQwenEngines();
		return { success: true };
	});
