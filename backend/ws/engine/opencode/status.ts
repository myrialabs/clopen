/**
 * Open Code Engine Status Handler
 *
 * Detects Open Code installation and reports status.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { getBackendOS } from '../../../utils/os';
import { readEngineSdkVersion } from '$backend/engine/sdk-loader';

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

		const sdkVersion = readEngineSdkVersion('@opencode-ai/sdk');

		return {
			installed: sdkVersion !== null,
			version: sdkVersion,
			backendOS: getBackendOS()
		};
	});
