/**
 * Engines, models and reasoning — every engine, every model it offers, and
 * the reasoning level when the model has one.
 *
 * Model lists come from the same `models:list` route the web picker uses, so
 * an engine that is not installed or not signed in answers with the same
 * reason the web shows, and a catalog that changes upstream changes here too.
 */

import { t } from 'elysia';
import type { EngineModel, EngineType } from '$shared/types/unified';
import { ENGINES } from '$shared/constants/engines';
import { engineQueries, sessionQueries } from '$backend/database/queries';
import { checkEngineSetup } from '$backend/engine/engine-setup';
import { defineAction } from '../define';
import type { ControlChoice, ControlContext, ControlResult } from '../types';
import { paged } from '../paging';
import { accessibleSession, createSession, modelOf, resolveTarget } from '../workspace';
import { escapeMd } from './projects';

const ENGINE_TYPES = ENGINES.map((engine) => engine.type) as [EngineType, ...EngineType[]];
const ENGINE_SCHEMA = t.Union(ENGINE_TYPES.map((type) => t.Literal(type)));

export function engineName(type: string): string {
	return ENGINES.find((engine) => engine.type === type)?.name ?? type;
}

/** Accept "claude", "Claude Code", "claude-code" — whatever a person types. */
export function parseEngine(input: string | undefined): EngineType | null {
	const needle = (input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
	if (!needle) return null;
	const exact = ENGINES.find((engine) => engine.type === needle || engine.name.toLowerCase().replace(/\s+/g, '-') === needle);
	if (exact) return exact.type;
	const prefix = ENGINES.find((engine) => engine.type.startsWith(needle) || engine.name.toLowerCase().startsWith(needle.replace(/-/g, ' ')));
	return prefix?.type ?? null;
}

/** One engine's models, searchable and paged: what `/model <engine>` and an engine button show. */
async function modelsOf(ctx: ControlContext, args: { engine: string; query?: string; page?: number }): Promise<ControlResult> {
	const engine = parseEngine(args.engine);
	if (!engine) throw new Error(`No engine called "${args.engine}". Engines: ${ENGINES.map((e) => e.type).join(', ')}.`);
	const models = await ctx.call<EngineModel[]>('models:list', { engine });
	const query = args.query?.trim().toLowerCase();
	const matching = query
		? models.filter((model) => `${model.engine.model.name} ${model.engine.model.id} ${model.engine.provider}`.toLowerCase().includes(query))
		: models;
	if (matching.length === 0) return { text: query ? `No ${engineName(engine)} model matches “${args.query}”.` : `${engineName(engine)} offers no models right now.` };

	const { session } = resolveTarget(ctx.target);
	const current = modelOf(session);
	const { choices, range } = paged(
		matching,
		args.page,
		(model): ControlChoice => ({
			label: model.engine.model.name,
			detail: model.engine.provider || undefined,
			current: current?.engine === engine && current.modelId === model.engine.model.id,
			action: 'models.set',
			args: { engine, provider: model.engine.provider, modelId: model.engine.model.id, modelName: model.engine.model.name }
		}),
		{ action: 'models.list', args: { engine, ...(args.query ? { query: args.query } : {}) } }
	);
	return { text: `**🤖 ${engineName(engine)} models${range}**${query ? ` matching “${escapeMd(args.query ?? '')}”` : ''}`, choices };
}

export const listEngines = defineAction({
	id: 'models.engines',
	group: 'models',
	title: 'Model',
	description: 'Pick the model for this session',
	args: t.Object({ engine: t.Optional(t.String()), query: t.Optional(t.String()) }),
	command: { name: 'model', argument: { keys: ['engine', 'query'], hint: '[engine] [search]' } },
	async run(ctx, args) {
		if (args.engine?.trim()) return modelsOf(ctx, { engine: args.engine, query: args.query });
		const { session } = resolveTarget(ctx.target);
		const current = modelOf(session);
		// The same readiness check the model picker and the chat gate use, so an
		// engine that would only answer "install it first" says so up front.
		const issues = await Promise.all(
			ENGINES.map((engine) => checkEngineSetup(engine.type, engineQueries.getActiveAccountForEngine(engine.type)?.id ?? 0).catch(() => null))
		);
		const ready = ENGINES.filter((_, index) => !issues[index]).length;
		const header = current ? `🤖 Now: \`${current.modelName}\` on ${engineName(current.engine)}.\n\n` : '';
		const note = ready < ENGINES.length ? `\n_⚠️ marks an engine that is not set up yet. Set it up in Clopen → Settings → Engines._` : '';
		return {
			text: `${header}**🤖 Pick an engine**${note}`,
			choices: ENGINES.map((engine, index) => ({
				label: `${issues[index] ? '⚠️ ' : ''}${engine.name}`,
				detail: issues[index] ? (issues[index]!.reason === 'not-installed' ? 'not installed' : issues[index]!.reason.replace(/-/g, ' ')) : engine.description,
				current: current?.engine === engine.type,
				action: 'models.list',
				args: { engine: engine.type }
			}))
		};
	}
});

export const listModels = defineAction({
	id: 'models.list',
	group: 'models',
	title: 'Models of an engine',
	description: 'Every model an engine offers, searchable, paged.',
	args: t.Object({
		engine: t.String({ minLength: 1 }),
		query: t.Optional(t.String()),
		page: t.Optional(t.Number({ minimum: 0 }))
	}),
	async run(ctx, args) {
		return modelsOf(ctx, args);
	}
});

export const setModel = defineAction({
	id: 'models.set',
	group: 'models',
	title: 'Use model',
	description: 'Use a model for the current session (or for the next one, when there is none).',
	args: t.Object({
		engine: ENGINE_SCHEMA,
		provider: t.String(),
		modelId: t.String({ minLength: 1 }),
		modelName: t.String({ minLength: 1 })
	}),
	async run(ctx, args) {
		const { project, session } = resolveTarget(ctx.target);
		const model = { engine: args.engine as EngineType, provider: args.provider, modelId: args.modelId, modelName: args.modelName };
		if (session) {
			const switchedEngine = session.engine !== model.engine;
			sessionQueries.updateEngineModel(session.id, model.engine, model.provider, model.modelId, model.modelName);
			if (switchedEngine) {
				// An account and a reasoning level belong to one engine: carried over
				// they would sign the new engine in as the old one's account. Cleared,
				// the next turn uses the new engine's active account and its default.
				sessionQueries.updateAccount(session.id, null, null);
				sessionQueries.updateReasoning(session.id, null);
			}
			return { text: `🤖 This session now uses \`${args.modelName}\` on ${engineName(args.engine)}.` };
		}
		// No session to switch: start one with this model, so the choice is kept.
		const created = createSession(project, model);
		return {
			text: `🤖 \`${args.modelName}\` on ${engineName(args.engine)}. Your next message starts a session with it.`,
			target: { projectId: project.id, sessionId: created.id }
		};
	}
});

export const listReasoning = defineAction({
	id: 'models.reasoning',
	group: 'models',
	title: 'Reasoning level',
	description: 'Set how hard the model thinks',
	args: t.Object({}),
	command: { name: 'reasoning' },
	async run(ctx) {
		const found = accessibleSession(ctx.target.sessionId);
		const current = modelOf(found?.session);
		if (!found || !current) return { text: 'Pick a model first with /model.' };
		const models = await ctx.call<EngineModel[]>('models:list', { engine: current.engine }, { projectId: found.project.id });
		const control = models.find((model) => model.engine.model.id === current.modelId)?.capabilities.reasoningControl;
		if (!control?.levels.length) return { text: `\`${current.modelName}\` has no reasoning level to choose.` };
		const active = found.session.reasoning_effort ?? control.default;
		return {
			text: `**🧠 Reasoning for \`${current.modelName}\`**`,
			choices: control.levels.map((level) => ({
				label: level.label,
				detail: level.value === control.default ? 'default' : undefined,
				current: level.value === active,
				action: 'models.set-reasoning',
				args: { value: level.value }
			}))
		};
	}
});

export const setReasoning = defineAction({
	id: 'models.set-reasoning',
	group: 'models',
	title: 'Use reasoning level',
	description: 'Set the reasoning level of the current session.',
	args: t.Object({ value: t.String({ minLength: 1 }) }),
	async run(ctx, args) {
		const found = accessibleSession(ctx.target.sessionId);
		if (!found) throw new Error('No session yet. Send a message first.');
		sessionQueries.updateReasoning(found.session.id, args.value);
		return { text: `🧠 Reasoning set to **${escapeMd(args.value)}**.` };
	}
});
