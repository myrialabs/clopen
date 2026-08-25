/**
 * GitHub Copilot Engine Status Handler
 *
 * Reports SDK availability and active account state. The SDK bundles its own
 * CLI internally so there is nothing to install — `installed` is always true.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';
import { getBackendOS } from '../../../utils/os';
import { readEngineSdkVersion } from '$backend/engine/sdk-loader';

export const copilotStatusHandler = createRouter()
	.http('engine:copilot-status', {
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
		debug.log('engine', 'Checking Copilot status...');

		const provider = engineQueries.getProviderBySlug('copilot', 'github');
		const accounts = provider ? engineQueries.getAccountsByProvider(provider.id) : [];
		const activeAccount = engineQueries.getActiveAccountForEngine('copilot');

		const sdkVersion = readEngineSdkVersion('@github/copilot-sdk');

		return {
			installed: sdkVersion !== null,
			version: sdkVersion,
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
