/**
 * OpenAI Codex Engine Status Handler
 *
 * Reports SDK availability + active account state. Codex differs from
 * Copilot in that the SDK does NOT bundle a CLI internally — the CLI must
 * be installed on PATH (System Tools → Codex CLI). `installed` reflects
 * whether the `codex` binary resolves on the host's PATH.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../database/queries';
import { resolveBinaryWithRefresh } from '../../../utils/cli';
import { getBackendOS } from '../../../utils/os';
import { debug } from '$shared/utils/logger';

function readSdkVersion(): string | null {
	try {
		const path = require.resolve('@openai/codex-sdk/package.json');
		const pkg = require(path) as { version?: string };
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

async function readCliVersion(): Promise<string | null> {
	const bin = await resolveBinaryWithRefresh('codex');
	if (!bin) return null;
	try {
		const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const stdout = await new Response(proc.stdout).text();
		const first = stdout.trim().split('\n')[0]?.trim() ?? '';
		return first || null;
	} catch {
		return null;
	}
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

		// authMode parsing — defer the import to avoid initializing fs paths in
		// the status hot path; only matters when an active account exists.
		let authMode: 'api_key' | 'chatgpt' | null = null;
		if (activeAccount) {
			const { authModeOf } = await import('../../../engine/adapters/codex/credential');
			authMode = authModeOf(activeAccount);
		}

		return {
			installed: cliVersion !== null,
			version: cliVersion,
			sdkVersion: readSdkVersion(),
			activeAccount: activeAccount
				? { id: activeAccount.id, name: activeAccount.name, authMode }
				: null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
