/**
 * Subagent CRUD Handlers (Settings → Subagents)
 *
 *   - subagents:list / get / create / update / parse-import / import / toggle / delete
 *   - subagents:detect — on-disk subagents (managed + adoptable) per engine
 *
 * Mutations are admin-gated. Changes take effect on the next chat stream.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { subagentService, detectSubagents, syncSubagentsAllEngines } from '$backend/subagents';

/** EngineType → value map (model id / tool list). {} = inherit / all. */
const ENGINE_MAP_SCHEMA = t.Record(t.String(), t.String());

const SUBAGENT_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	toolsByEngine: ENGINE_MAP_SCHEMA,
	modelByEngine: ENGINE_MAP_SCHEMA,
	source: t.Union([t.Literal('custom'), t.Literal('imported')]),
	enabled: t.Boolean(),
	present: t.Boolean(),
	createdAt: t.String()
});

const FIELDS_SCHEMA = {
	name: t.String(),
	description: t.String(),
	toolsByEngine: t.Optional(ENGINE_MAP_SCHEMA),
	modelByEngine: t.Optional(ENGINE_MAP_SCHEMA),
	body: t.String()
};

const DETECTED_SCHEMA = t.Object({
	engine: t.String(),
	detected: t.Array(t.Object({
		slug: t.String(),
		name: t.String(),
		description: t.String(),
		path: t.String(),
		managed: t.Boolean(),
		adoptable: t.Boolean()
	}))
});

export const subagentCrudHandler = createRouter()
	.http('subagents:list', {
		data: t.Object({}),
		response: t.Object({ subagents: t.Array(SUBAGENT_SCHEMA) })
	}, async () => {
		debug.log('path', 'subagents:list');
		return { subagents: await subagentService.list() };
	})
	.http('subagents:get', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ subagent: SUBAGENT_SCHEMA, body: t.String() })
	}, async ({ data }) => {
		debug.log('path', `subagents:get ${data.id}`);
		const result = await subagentService.get(data.id);
		if (!result) throw new Error('Subagent not found');
		return result;
	})
	.http('subagents:create', {
		data: t.Object(FIELDS_SCHEMA),
		response: t.Object({ subagent: SUBAGENT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `subagents:create ${data.name}`);
		if (!data.name.trim()) throw new Error('A subagent name is required');
		if (!data.description.trim()) throw new Error('A subagent description is required');
		const subagent = await subagentService.create(data);
		await syncSubagentsAllEngines();
		return { subagent };
	})
	.http('subagents:update', {
		data: t.Object({ id: t.Number(), ...FIELDS_SCHEMA }),
		response: t.Object({ subagent: SUBAGENT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `subagents:update ${data.id}`);
		if (!data.name.trim()) throw new Error('A subagent name is required');
		if (!data.description.trim()) throw new Error('A subagent description is required');
		const subagent = await subagentService.update(data.id, data);
		await syncSubagentsAllEngines();
		return { subagent };
	})
	.http('subagents:parse-import', {
		data: t.Object({ text: t.String() }),
		response: t.Object({
			name: t.String(),
			description: t.String(),
			toolsByEngine: ENGINE_MAP_SCHEMA,
			modelByEngine: ENGINE_MAP_SCHEMA,
			body: t.String()
		})
	}, async ({ data }) => {
		debug.log('path', 'subagents:parse-import');
		return subagentService.parsePreview(data.text);
	})
	.http('subagents:import', {
		data: t.Object({ text: t.String(), name: t.Optional(t.String()) }),
		response: t.Object({ subagent: SUBAGENT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', 'subagents:import');
		const subagent = await subagentService.import(data.text, data.name);
		await syncSubagentsAllEngines();
		return { subagent };
	})
	.http('subagents:toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ subagent: SUBAGENT_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `subagents:toggle ${data.id} → ${data.enabled}`);
		const subagent = subagentService.toggle(data.id, data.enabled);
		await syncSubagentsAllEngines();
		return { subagent };
	})
	.http('subagents:delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `subagents:delete ${data.id}`);
		await subagentService.remove(data.id);
		await syncSubagentsAllEngines();
		return { success: true };
	})
	.http('subagents:detect', {
		data: t.Object({ projectPath: t.Optional(t.String()) }),
		response: t.Object({ groups: t.Array(DETECTED_SCHEMA) })
	}, async ({ data }) => {
		debug.log('path', 'subagents:detect');
		return { groups: await detectSubagents(data.projectPath) };
	});
