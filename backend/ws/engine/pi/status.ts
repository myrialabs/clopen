/**
 * Pi Engine Status Handler
 *
 * Pi is an in-process SDK (`@earendil-works/pi-coding-agent`) — there is no CLI
 * to install, so `installed` is always true. Reports the SDK version and active
 * account state.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';
import { getBackendOS } from '../../../utils/os';

function readSdkVersion(): string | null {
	try {
		const path = require.resolve('@earendil-works/pi-coding-agent/package.json');
		const pkg = require(path) as { version?: string };
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

export const piStatusHandler = createRouter()
	.http('engine:pi-status', {
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
		debug.log('engine', 'Checking Pi status...');
		const provider = engineQueries.getProviderBySlug('pi', 'pi');
		const accounts = provider ? engineQueries.getAccountsByProvider(provider.id) : [];
		const activeAccount = engineQueries.getActiveAccountForEngine('pi');
		return {
			installed: true,
			version: readSdkVersion(),
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
