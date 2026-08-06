/**
 * GitHub Copilot Account Management Handlers
 *
 * Auth model: paste-token only. The user provides a GitHub Personal Access
 * Token with Copilot access (no PTY / device-flow). Tokens are stored as the
 * generic `credential` field on engine_accounts under provider slug 'github'.
 *
 * Switching/deleting active accounts disposes the project-scoped CopilotEngine
 * instances so the next stream picks up the new credential.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { disposeAllProjectEnginesByType } from '../../../engine';

async function disposeCopilotEngines(): Promise<void> {
	try {
		await disposeAllProjectEnginesByType('copilot');
	} catch {
		/* engine may not be initialised — ignore */
	}
}

export const copilotAccountsHandler = createRouter()

	.http('engine:copilot-accounts-list', {
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
		const provider = engineQueries.getProviderBySlug('copilot', 'github');
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

	.http('engine:copilot-accounts-add', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			token: t.String({ minLength: 1 })
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
		const provider = engineQueries.getProviderBySlug('copilot', 'github');
		if (!provider) {
			throw new Error('GitHub Copilot provider not found in database');
		}

		const account = engineQueries.createAccount(provider.id, data.name.trim(), data.token.trim());

		// If this is the first account it became active — drop any stale engine instances.
		if (account.is_active === 1) {
			await disposeCopilotEngines();
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

	.http('engine:copilot-accounts-switch', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.switchAccount(data.id);
		await disposeCopilotEngines();
		return { success: true };
	})

	.http('engine:copilot-accounts-delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const active = engineQueries.getActiveAccountForEngine('copilot');
		engineQueries.deleteAccount(data.id);
		if (active?.id === data.id) await disposeCopilotEngines();
		return { success: true };
	})

	.http('engine:copilot-accounts-rename', {
		data: t.Object({ id: t.Number(), name: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.renameAccount(data.id, data.name.trim());
		return { success: true };
	})

	// Replace the stored PAT for an account. When the edited account is the
	// active one, drop engine instances so the next stream picks up the token.
	.http('engine:copilot-accounts-update-token', {
		data: t.Object({ id: t.Number(), token: t.String({ minLength: 1 }) }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		engineQueries.updateAccountCredential(data.id, data.token.trim());
		const active = engineQueries.getActiveAccountForEngine('copilot');
		if (active?.id === data.id) await disposeCopilotEngines();
		return { success: true };
	})

	// Restart all Copilot engine instances. Use after changing the active token
	// so subsequent models:list / chat calls re-initialise with fresh credentials.
	.http('engine:copilot-restart', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async () => {
		await disposeCopilotEngines();
		return { success: true };
	});
