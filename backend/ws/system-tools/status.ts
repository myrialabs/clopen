/**
 * System Tool Status Handlers
 *
 * Reports installation status for each managed tool (git, claude,
 * opencode, chrome). The corresponding recipe is bundled so the
 * frontend can render the install button state and manual fallback
 * without a second round-trip.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { getToolStatus, resolveRecipe } from '$backend/engine/install-recipes';
import { getActiveSessionForTool } from '$backend/engine/install-runner';

const TOOL_UNION = t.Union([
	t.Literal('git'),
	t.Literal('claude'),
	t.Literal('opencode'),
	t.Literal('copilot'),
	t.Literal('chrome'),
	t.Literal('cloudflared')
]);

const RECIPE_SCHEMA = t.Object({
	tool: TOOL_UNION,
	autoInstallable: t.Boolean(),
	unavailableReason: t.Optional(t.String()),
	displayCommand: t.Optional(t.String()),
	missingPrereqs: t.Array(TOOL_UNION),
	manualInstructions: t.Array(t.Object({
		label: t.String(),
		command: t.String(),
		docs: t.Optional(t.String())
	})),
	pendingCurlDownload: t.Optional(t.Object({
		version: t.String(),
		url: t.String(),
		sha256: t.String(),
		archKey: t.String()
	}))
});

const STATUS_SCHEMA = t.Object({
	tool: TOOL_UNION,
	installed: t.Boolean(),
	version: t.Union([t.String(), t.Null()]),
	source: t.Union([t.String(), t.Null()])
});

const ACTIVE_SESSION_SCHEMA = t.Union([
	t.Null(),
	t.Object({
		sessionId: t.String(),
		tool: TOOL_UNION,
		status: t.Union([
			t.Literal('running'),
			t.Literal('success'),
			t.Literal('failed'),
			t.Literal('cancelled')
		]),
		exitCode: t.Union([t.Number(), t.Null()]),
		startedAt: t.Number(),
		endedAt: t.Union([t.Number(), t.Null()]),
		totalLines: t.Number(),
		recentLines: t.Array(t.String()),
		displayCommand: t.String()
	})
]);

function toRecipeDTO(tool: 'git' | 'claude' | 'opencode' | 'copilot' | 'chrome' | 'cloudflared', recipe: Awaited<ReturnType<typeof resolveRecipe>>) {
	return {
		tool,
		autoInstallable: recipe.autoInstallable,
		unavailableReason: recipe.unavailableReason,
		displayCommand: recipe.displayCommand,
		missingPrereqs: recipe.missingPrereqs,
		manualInstructions: recipe.manualInstructions,
		pendingCurlDownload: recipe.pendingCurlDownload
	};
}

export const systemToolsStatusHandler = createRouter()
	.http('system-tools:status', {
		data: t.Object({ tool: TOOL_UNION }),
		response: t.Object({
			status: STATUS_SCHEMA,
			recipe: RECIPE_SCHEMA,
			activeSession: ACTIVE_SESSION_SCHEMA
		})
	}, async ({ data }) => {
		debug.log('path', `system-tools:status for ${data.tool}`);
		const [status, recipe] = await Promise.all([
			getToolStatus(data.tool),
			resolveRecipe(data.tool)
		]);
		return {
			status,
			recipe: toRecipeDTO(data.tool, recipe),
			activeSession: getActiveSessionForTool(data.tool)
		};
	})
	.http('system-tools:status-all', {
		data: t.Object({}),
		response: t.Object({
			tools: t.Array(t.Object({
				status: STATUS_SCHEMA,
				recipe: RECIPE_SCHEMA,
				activeSession: ACTIVE_SESSION_SCHEMA
			}))
		})
	}, async () => {
		debug.log('path', 'system-tools:status-all');
		const ids = ['git', 'claude', 'opencode', 'copilot', 'chrome', 'cloudflared'] as const;
		const tools = await Promise.all(ids.map(async (id) => {
			const [status, recipe] = await Promise.all([
				getToolStatus(id),
				resolveRecipe(id)
			]);
			return {
				status,
				recipe: toRecipeDTO(id, recipe),
				activeSession: getActiveSessionForTool(id)
			};
		}));
		return { tools };
	});
