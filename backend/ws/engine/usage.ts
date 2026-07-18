/**
 * AI Engine Usage WebSocket Router
 *
 * Implements the unified `engine:get-usage` router to fetch real-time
 * quota and usage snapshots from the active provider adapters.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { getClaudeUsage } from '../../engine/adapters/claude/usage';
import { getCopilotUsage } from '../../engine/adapters/copilot/usage';
import { getCodexUsage } from '../../engine/adapters/codex/usage';
import { getOpenCodeUsage } from '../../engine/adapters/opencode/usage';
import { debug } from '$shared/utils/logger';

const UsageQuotaSchema = t.Object({
	percentRemaining: t.Number(),
	quotaType: t.String(),
	providerId: t.String(),
	resetsAt: t.Union([t.String(), t.Null()]),
	resetText: t.Optional(t.String()),
});

const UsageSnapshotSchema = t.Object({
	providerId: t.String(),
	quotas: t.Array(UsageQuotaSchema),
	capturedAt: t.String(),
	accountEmail: t.Optional(t.Union([t.String(), t.Null()])),
	accountOrganization: t.Optional(t.Union([t.String(), t.Null()])),
	accountTier: t.Optional(t.Union([t.String(), t.Null()])),
});

export const engineUsageRouter = createRouter()
	.http('engine:get-usage', {
		data: t.Object({
			engineType: t.String(),
			accountId: t.Optional(t.Number()),
		}),
		response: t.Object({
			success: t.Boolean(),
			snapshot: t.Union([UsageSnapshotSchema, t.Null()]),
			error: t.Optional(t.String()),
		})
	}, async ({ data }) => {
		const { engineType, accountId } = data;
		debug.log('engine', `engine:get-usage called for ${engineType} (accountId: ${accountId ?? 'active'})`);

		try {
			let snapshot = null;
			switch (engineType) {
				case 'claude-code':
					snapshot = await getClaudeUsage(accountId);
					break;
				case 'copilot':
					snapshot = await getCopilotUsage(accountId);
					break;
				case 'codex':
					snapshot = await getCodexUsage(accountId);
					break;
				case 'opencode':
					snapshot = await getOpenCodeUsage();
					break;
				default:
					debug.warn('engine', `engine:get-usage called for unsupported engineType: ${engineType}`);
					break;
			}

			return {
				success: true,
				snapshot
			};
		} catch (err: any) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			debug.error('engine', `Failed to fetch usage for ${engineType}:`, err);
			return {
				success: false,
				snapshot: null,
				error: errorMsg
			};
		}
	});
