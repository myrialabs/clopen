/**
 * Open Code Engine Status Handler
 *
 * Detects Open Code installation and reports status.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { getBackendOS, detectCLI } from '../utils';

export const openCodeStatusHandler = createRouter()
	.http('engine:opencode-status', {
		data: t.Object({}),
		response: t.Object({
			installed: t.Boolean(),
			version: t.Union([t.String(), t.Null()]),
			backendOS: t.Union([t.Literal('windows'), t.Literal('macos'), t.Literal('linux')])
		})
	}, async () => {
		debug.log('engine', 'Checking Open Code status...');

		const { installed, version } = await detectCLI('opencode');

		return {
			installed,
			version,
			backendOS: getBackendOS()
		};
	});
