/**
 * Command CRUD Handlers (Settings → Commands)
 *
 *   - commands:list / get / create / update / parse-import / import / toggle / delete
 *   - commands:detect — on-disk commands (managed + adoptable) per engine
 *
 * Mutations are admin-gated. Changes take effect on the next chat stream, when
 * each engine re-syncs its commands.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { commandService, detectCommands, syncCommandsAllEngines } from '$backend/commands';
import { resolveActiveProfileId, artifactFilter } from '$backend/profiles';

/** EngineType → value map (model id / tool list). {} = inherit / all. */
const ENGINE_MAP_SCHEMA = t.Record(t.String(), t.String());

const COMMAND_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	argumentHint: t.Union([t.String(), t.Null()]),
	modelByEngine: ENGINE_MAP_SCHEMA,
	source: t.Union([t.Literal('custom'), t.Literal('imported')]),
	enabled: t.Boolean(),
	present: t.Boolean(),
	createdAt: t.String()
});

const FIELDS_SCHEMA = {
	name: t.String(),
	description: t.String(),
	argumentHint: t.Optional(t.Union([t.String(), t.Null()])),
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

export const commandCrudHandler = createRouter()
	.http('commands:list', {
		data: t.Object({}),
		response: t.Object({ commands: t.Array(COMMAND_SCHEMA) })
	}, async () => {
		debug.log('path', 'commands:list');
		return { commands: await commandService.list() };
	})
	.http('commands:get', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ command: COMMAND_SCHEMA, body: t.String() })
	}, async ({ data }) => {
		debug.log('path', `commands:get ${data.id}`);
		const result = await commandService.get(data.id);
		if (!result) throw new Error('Command not found');
		return result;
	})
	.http('commands:create', {
		data: t.Object(FIELDS_SCHEMA),
		response: t.Object({ command: COMMAND_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `commands:create ${data.name}`);
		if (!data.name.trim()) throw new Error('A command name is required');
		const command = await commandService.create(data);
		await syncCommandsAllEngines();
		return { command };
	})
	.http('commands:update', {
		data: t.Object({ id: t.Number(), ...FIELDS_SCHEMA }),
		response: t.Object({ command: COMMAND_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `commands:update ${data.id}`);
		if (!data.name.trim()) throw new Error('A command name is required');
		const command = await commandService.update(data.id, data);
		await syncCommandsAllEngines();
		return { command };
	})
	.http('commands:parse-import', {
		data: t.Object({ text: t.String() }),
		response: t.Object({
			name: t.String(),
			description: t.String(),
			argumentHint: t.Union([t.String(), t.Null()]),
			modelByEngine: ENGINE_MAP_SCHEMA,
			body: t.String()
		})
	}, async ({ data }) => {
		debug.log('path', 'commands:parse-import');
		return commandService.parsePreview(data.text);
	})
	.http('commands:import', {
		data: t.Object({ text: t.String(), name: t.Optional(t.String()) }),
		response: t.Object({ command: COMMAND_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', 'commands:import');
		const command = await commandService.import(data.text, data.name);
		await syncCommandsAllEngines();
		return { command };
	})
	.http('commands:toggle', {
		data: t.Object({ id: t.Number(), enabled: t.Boolean() }),
		response: t.Object({ command: COMMAND_SCHEMA })
	}, async ({ data }) => {
		debug.log('path', `commands:toggle ${data.id} → ${data.enabled}`);
		const command = commandService.toggle(data.id, data.enabled);
		await syncCommandsAllEngines();
		return { command };
	})
	.http('commands:delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `commands:delete ${data.id}`);
		await commandService.remove(data.id);
		await syncCommandsAllEngines();
		return { success: true };
	})
	.http('commands:available', {
		// Non-admin: commands for the chat "/" picker (display fields only),
		// narrowed by the session's active profile (if any) same as stream sync.
		data: t.Object({
			profileId: t.Optional(t.Union([t.Number(), t.Null()])),
			projectId: t.Optional(t.String())
		}),
		response: t.Object({
			commands: t.Array(t.Object({
				slug: t.String(),
				name: t.String(),
				description: t.String(),
				argumentHint: t.Union([t.String(), t.Null()])
			}))
		})
	}, async ({ data }) => {
		debug.log('path', 'commands:available');
		const activeProfileId = resolveActiveProfileId(data.profileId ?? null, data.projectId);
		const filter = artifactFilter(activeProfileId, 'command');
		return { commands: commandService.available(filter) };
	})
	.http('commands:detect', {
		data: t.Object({ projectPath: t.Optional(t.String()) }),
		response: t.Object({ groups: t.Array(DETECTED_SCHEMA) })
	}, async ({ data }) => {
		debug.log('path', 'commands:detect');
		return { groups: await detectCommands(data.projectPath) };
	});
