/**
 * OpenAI Codex Engine Status Handler
 *
 * Reports SDK availability + active account state. `installed` tracks the SDK;
 * `version` is the CLI's, since that is the process Codex actually runs. That
 * binary is vendored inside the SDK's platform package in the managed stack dir
 * (or comes from PATH when the user installed Codex themselves) — reading it
 * off PATH alone left the version blank on a Stack-only install.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { resolveEngineCli } from '$backend/engine/engine-cli';
import { getBackendOS } from '../../../utils/os';
import { debug } from '$shared/utils/logger';
import { readEngineSdkVersion } from '$backend/engine/sdk-loader';

async function readCliVersion(): Promise<string | null> {
	// `resolveEngineCli` already ran `--version` on the binary it handed back,
	// so the version comes for free with the resolution.
	const cli = await resolveEngineCli('codex');
	return cli?.version ?? null;
}

export const codexStatusHandler = createRouter()
	.http('engine:codex-status', {
		data: t.Object({}),
		response: t.Object({
			installed: t.Boolean(),
			version: t.Union([t.String(), t.Null()]),
			sdkVersion: t.Union([t.String(), t.Null()]),
			activeAccount: t.Union([
				t.Object({
					id: t.Number(),
					name: t.String(),
					authMode: t.Union([t.Literal('api_key'), t.Literal('chatgpt'), t.Null()])
				}),
				t.Null()
			]),
			accountsCount: t.Number(),
			backendOS: t.Union([t.Literal('windows'), t.Literal('macos'), t.Literal('linux')])
		})
	}, async () => {
		debug.log('engine', 'Checking Codex status...');

		const provider = engineQueries.getProviderBySlug('codex', 'openai');
		const accounts = provider ? engineQueries.getAccountsByProvider(provider.id) : [];
		const activeAccount = engineQueries.getActiveAccountForEngine('codex');

		const cliVersion = await readCliVersion();
		const sdkVersion = readEngineSdkVersion('@openai/codex-sdk');

		// authMode parsing — defer the import to avoid initializing fs paths in
		// the status hot path; only matters when an active account exists.
		let authMode: 'api_key' | 'chatgpt' | null = null;
		if (activeAccount) {
			const { authModeOf } = await import('../../../engine/adapters/codex/credential');
			authMode = authModeOf(activeAccount);
		}

		return {
			installed: sdkVersion !== null,
			version: cliVersion,
			sdkVersion,
			activeAccount: activeAccount
				? { id: activeAccount.id, name: activeAccount.name, authMode }
				: null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
