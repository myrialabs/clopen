/**
 * Claude Code Engine Status Handler
 *
 * Detects Claude Code installation and reports status.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { engineQueries } from '../../../lib/database/queries';
import { debug } from '$shared/utils/logger';
import { getBackendOS, detectCLI } from '../utils';

export const claudeCodeStatusHandler = createRouter()
	.http('engine:claude-status', {
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
		debug.log('engine', 'Checking Claude Code status...');

		const { installed, version } = await detectCLI('claude');
		const accounts = engineQueries.getClaudeAccounts();
		const activeAccount = engineQueries.getActiveClaudeAccount();

		return {
			installed,
			version,
			activeAccount: activeAccount ? { id: activeAccount.id, name: activeAccount.name } : null,
			accountsCount: accounts.length,
			backendOS: getBackendOS()
		};
	});
