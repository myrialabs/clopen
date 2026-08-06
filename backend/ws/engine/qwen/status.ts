/**
 * Qwen Code Engine Status Handler
 *
 * Reports SDK availability and active account state. The SDK bundles its own
 * CLI internally (`@qwen-code/sdk` v0.1.1+) so `installed` is always true.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';
import { getBackendOS } from '../../../utils/os';
import { readEngineSdkVersion } from '$backend/engine/sdk-loader';

export const qwenStatusHandler = createRouter()
	.http('engine:qwen-status', {
		data: t.Object({}),
		response: t.Object({
			installed: t.Boolean(),
			version: t.Union([t.String(), t.Null()]),
			activeAccount: t.Union([
				t.Object({
					id: t.Number(),
					name: t.String()
				}),
				t.Null()
			]),
			accountsCount: t.Number(),
			backendOS: t.Union([t.Literal('windows'), t.Literal('macos'), t.Literal('linux')])
		})
	}, async () => {
		debug.log('engine', 'Checking Qwen Code status...');

		const provider = engineQueries.getProviderBySlug('qwen', 'qwen');
		const accounts = provider ? engineQueries.getAccountsByProvider(provider.id) : [];
		const activeAccount = engineQueries.getActiveAccountForEngine('qwen');

		const sdkVersion = readEngineSdkVersion('@qwen-code/sdk');

		return {
			installed: sdkVersion !== null,
			version: sdkVersion,
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
