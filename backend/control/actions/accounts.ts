/**
 * Engine accounts — which account each engine signs in with.
 *
 * Every call goes through the engine's own account routes, so switching here
 * does exactly what switching in Settings → Engines does (credential files,
 * hot reload, the lot). Accounts are ADDED in Clopen only: a key or a sign-in
 * never goes through a chat.
 */

import { t } from 'elysia';
import type { EngineType } from '$shared/types/unified';
import { ENGINES } from '$shared/constants/engines';
import { sessionQueries } from '$backend/database/queries';
import { defineAction } from '../define';
import { accessibleSession } from '../workspace';
import { engineName, parseEngine } from './models';
import { escapeMd } from './projects';

interface AccountRow {
	id: number;
	name: string;
	isActive: boolean;
}

/** The route-name slug an engine's account routes use. */
function accountSlug(engine: EngineType): string {
	return engine === 'claude-code' ? 'claude' : engine;
}

async function accountsOf(call: <T>(action: string, data?: Record<string, unknown>) => Promise<T>, engine: EngineType): Promise<Array<AccountRow & { provider?: string }>> {
	if (engine === 'opencode') {
		const { providers } = await call<{ providers: Array<{ name: string; isEnabled: boolean; accounts: AccountRow[] }> }>('engine:opencode-providers-list');
		return providers.filter((provider) => provider.isEnabled).flatMap((provider) => provider.accounts.map((account) => ({ ...account, provider: provider.name })));
	}
	const { accounts } = await call<{ accounts: AccountRow[] }>(`engine:${accountSlug(engine)}-accounts-list`);
	return accounts;
}

export const listAccounts = defineAction({
	id: 'accounts.list',
	group: 'accounts',
	title: 'Engine accounts',
	description: 'Switch an engine account',
	args: t.Object({ engine: t.Optional(t.String()) }),
	command: { name: 'accounts', argument: { keys: ['engine'], hint: '[engine]' } },
	async run(ctx, args) {
		const engine = parseEngine(args.engine);
		if (!engine) {
			return {
				text: '**🔑 Accounts for which engine?**',
				choices: ENGINES.map((info) => ({ label: info.name, action: 'accounts.list', args: { engine: info.type } }))
			};
		}
		const accounts = await accountsOf(ctx.call, engine);
		const hint = '\n\nAdd accounts in Clopen → Settings → Engines.';
		if (accounts.length === 0) return { text: `No ${engineName(engine)} accounts yet.${hint}` };
		return {
			text: `**🔑 ${engineName(engine)} accounts**${hint}`,
			choices: accounts.map((account) => ({
				label: account.name,
				detail: account.provider,
				current: account.isActive,
				action: 'accounts.switch',
				args: { engine, accountId: account.id }
			}))
		};
	}
});

export const switchAccount = defineAction({
	id: 'accounts.switch',
	group: 'accounts',
	title: 'Switch account',
	description: 'Make an account the one an engine signs in with, for the current session too.',
	args: t.Object({ engine: t.String({ minLength: 1 }), accountId: t.Number() }),
	async run(ctx, args) {
		const engine = parseEngine(args.engine);
		if (!engine) throw new Error(`No engine called "${args.engine}".`);
		const accounts = await accountsOf(ctx.call, engine);
		const account = accounts.find((row) => row.id === args.accountId);
		if (!account) throw new Error('That account no longer exists.');
		if (engine === 'opencode') await ctx.call('engine:opencode-account-switch', { accountId: account.id });
		else await ctx.call(`engine:${accountSlug(engine)}-accounts-switch`, { id: account.id });
		// The session pins an account of its own; follow the switch when it runs on this engine.
		const found = accessibleSession(ctx.target.sessionId);
		if (found?.session.engine === engine) sessionQueries.updateAccount(found.session.id, account.id, account.name);
		return { text: `🔑 ${engineName(engine)} now signs in as **${escapeMd(account.name)}**.` };
	}
});
