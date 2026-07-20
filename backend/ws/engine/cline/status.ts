/**
 * Cline Engine Status Handler
 *
 * Cline is an in-process SDK (`@cline/sdk`) — there is no CLI to install, so
 * `installed` is always true. Reports the SDK version and active account state.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';
import { getBackendOS } from '../../../utils/os';

function readSdkVersion(): string | null {
	try {
		const path = require.resolve('@cline/sdk/package.json');
		const pkg = require(path) as { version?: string };
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

export const clineStatusHandler = createRouter()
	.http('engine:cline-status', {
		data: t.Object({}),
		response: t.Object({
			installed: t.Boolean(),
			version: t.Union([t.String(), t.Null()]),
			activeAccount: t.Union([
				t.Object({ id: t.Number(), name: t.String() }),
				t.Null()
			]),
			accountsCount: t.Number(),
			backendOS: t.Union([t.Literal('windows'), t.Literal('macos'), t.Literal('linux')])
		})
	}, async () => {
		debug.log('engine', 'Checking Cline status...');
		const provider = engineQueries.getProviderBySlug('cline', 'cline');
		const accounts = provider ? engineQueries.getAccountsByProvider(provider.id) : [];
		const activeAccount = engineQueries.getActiveAccountForEngine('cline');
		return {
			installed: true,
			version: readSdkVersion(),
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
