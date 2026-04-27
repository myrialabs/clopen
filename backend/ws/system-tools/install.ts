/**
 * System Tool Install Handlers
 *
 * HTTP-style routes start/cancel installs and look up session state.
 * Server → client events stream stdout/stderr lines and signal the
 * final status. Install sessions are created on the backend and keyed
 * by a server-generated session id; clients only pick the tool id.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import {
	startInstall,
	cancelInstall,
	getSession,
	InstallAlreadyRunningError,
	InstallNotAutoInstallableError
} from '$backend/engine/install-runner';

const TOOL_UNION = t.Union([
	t.Literal('git'),
	t.Literal('claude'),
	t.Literal('opencode'),
	t.Literal('copilot'),
	t.Literal('chrome'),
	t.Literal('cloudflared')
]);

const STATUS_UNION = t.Union([
	t.Literal('running'),
	t.Literal('success'),
	t.Literal('failed'),
	t.Literal('cancelled')
]);

export const systemToolsInstallHandler = createRouter()

	.http('system-tools:install-start', {
		data: t.Object({ tool: TOOL_UNION }),
		response: t.Object({
			sessionId: t.String(),
			tool: TOOL_UNION,
			displayCommand: t.String(),
			startedAt: t.Number()
		})
	}, async ({ conn, data }) => {
		const userId = ws.getUserId(conn);
		if (!userId) throw new Error('Not authenticated');

		debug.log('path', `install-start requested: tool=${data.tool} user=${userId}`);
		try {
			const session = await startInstall(data.tool, userId);
			return {
				sessionId: session.id,
				tool: data.tool,
				displayCommand: session.recipe.displayCommand ?? '',
				startedAt: session.startedAt
			};
		} catch (err) {
			if (err instanceof InstallAlreadyRunningError) {
				throw new Error(`Install already running for ${err.tool}`);
			}
			if (err instanceof InstallNotAutoInstallableError) {
				throw new Error(err.message);
			}
			throw err;
		}
	})

	.http('system-tools:install-cancel', {
		data: t.Object({ sessionId: t.String() }),
		response: t.Object({ cancelled: t.Boolean() })
	}, async ({ data }) => {
		const cancelled = cancelInstall(data.sessionId);
		return { cancelled };
	})

	.http('system-tools:install-session', {
		data: t.Object({ sessionId: t.String() }),
		response: t.Object({
			session: t.Union([
				t.Null(),
				t.Object({
					sessionId: t.String(),
					tool: TOOL_UNION,
					status: STATUS_UNION,
					exitCode: t.Union([t.Number(), t.Null()]),
					startedAt: t.Number(),
					endedAt: t.Union([t.Number(), t.Null()]),
					totalLines: t.Number(),
					recentLines: t.Array(t.String()),
					displayCommand: t.String()
				})
			])
		})
	}, async ({ data }) => {
		return { session: getSession(data.sessionId) };
	})

	// ═══ Server → client events ═══

	.emit('system-tools:install-started', t.Object({
		sessionId: t.String(),
		tool: TOOL_UNION,
		displayCommand: t.String(),
		startedAt: t.Number()
	}))

	.emit('system-tools:install-stream', t.Object({
		sessionId: t.String(),
		tool: TOOL_UNION,
		type: t.Union([t.Literal('stdout'), t.Literal('stderr')]),
		line: t.String()
	}))

	.emit('system-tools:install-finished', t.Object({
		sessionId: t.String(),
		tool: TOOL_UNION,
		status: STATUS_UNION,
		exitCode: t.Number(),
		endedAt: t.Number()
	}));
