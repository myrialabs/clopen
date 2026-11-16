/**
 * Instruction Handlers (Library → Rules)
 *
 *   - instructions:get-global / save-global
 *   - instructions:get-project / save-project
 *
 * The managed block is injected into each engine's memory file as a
 * marker-region; hand-written content is preserved.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { instructionService } from '$backend/instructions';

const INSTRUCTION_SCHEMA = t.Object({
	scope: t.Union([t.Literal('global'), t.Literal('project')]),
	projectId: t.Union([t.String(), t.Null()]),
	content: t.String(),
	enabled: t.Boolean(),
	updatedAt: t.Union([t.String(), t.Null()]),
	engineFiles: t.Array(t.Object({ engine: t.String(), fileName: t.String() }))
});

export const instructionCrudHandler = createRouter()
	.http('rules:get-global', {
		data: t.Object({}),
		response: t.Object({ instruction: INSTRUCTION_SCHEMA })
	}, async () => {
		debug.log('path', 'rules:get-global');
		return { instruction: instructionService.getGlobal() };
	})
	.http('rules:save-global', {
		data: t.Object({ content: t.String(), enabled: t.Boolean() }),
		response: t.Object({ instruction: INSTRUCTION_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', 'rules:save-global');
		return { instruction: instructionService.saveGlobal(data.content, data.enabled) };
	})
	.http('rules:get-project', {
		data: t.Object({ projectId: t.String() }),
		response: t.Object({ instruction: INSTRUCTION_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `rules:get-project ${data.projectId}`);
		return { instruction: instructionService.getForProject(data.projectId) };
	})
	.http('rules:save-project', {
		data: t.Object({ projectId: t.String(), content: t.String(), enabled: t.Boolean() }),
		response: t.Object({ instruction: INSTRUCTION_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `rules:save-project ${data.projectId}`);
		return { instruction: instructionService.saveForProject(data.projectId, data.content, data.enabled) };
	});
