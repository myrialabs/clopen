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
import { readEngineSdkVersion } from '$backend/engine/sdk-loader';

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
		const sdkVersion = readEngineSdkVersion('@cline/sdk');
		return {
			installed: sdkVersion !== null,
			version: sdkVersion,
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
