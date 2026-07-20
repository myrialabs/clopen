/**
 * Settings CRUD Operations
 *
 * HTTP endpoints for settings management:
 * - Get single setting or all settings
 * - Update single setting
 * - Batch update multiple settings
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { settingsQueries } from '../../database/queries';
import { initializeEngine } from '../../engine';
import { registerModels } from '$shared/constants/engines';
import type { EngineType } from '$shared/types/unified';

export const crudHandler = createRouter()
	// Get settings
	.http('settings:get', {
		data: t.Object({
			key: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data }) => {
		if (data.key) {
			const setting = settingsQueries.get(data.key);
			if (!setting) {
				throw new Error('Setting not found');
			}
			return setting;
		} else {
			const settings = settingsQueries.getAll();
			return settings;
		}
	})

	// Update single setting
	.http('settings:update', {
		data: t.Object({
			key: t.String({ minLength: 1 }),
			value: t.Any()
		}),
		response: t.Any()
	}, async ({ data }) => {
		const { key, value } = data;

		if (!key || value === undefined) {
			throw new Error('Key and value are required');
		}

		settingsQueries.set(key, value);
		const setting = settingsQueries.get(key);

		return setting;
	})

	// Merge-update system settings (admin only).
	// Reads the current `system:settings` blob, merges the provided patch, and
	// writes it back atomically. Sending only the changed keys prevents a partial
	// update from clobbering sibling fields (e.g. onboardingComplete) when a
	// client's in-memory copy of the settings is stale.
	.http('settings:update-system', {
		data: t.Object({
			patch: t.Record(t.String(), t.Any())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const KEY = 'system:settings';
		const existing = settingsQueries.get(KEY);

		let current: Record<string, unknown> = {};
		if (existing?.value) {
			try {
				current = typeof existing.value === 'string'
					? JSON.parse(existing.value)
					: (existing.value as Record<string, unknown>);
			} catch {
				current = {};
			}
		}

		const merged = { ...current, ...data.patch };
		settingsQueries.set(KEY, JSON.stringify(merged));

		return settingsQueries.get(KEY);
	})

	// Batch update multiple settings
	.http('settings:update-batch', {
		data: t.Object({
			settings: t.Array(
				t.Object({
					key: t.String({ minLength: 1 }),
					value: t.Any()
				})
			)
		}),
		response: t.Any()
	}, async ({ data }) => {
		for (const { key, value } of data.settings) {
			if (key && value !== undefined) {
				settingsQueries.set(key, value);
			}
		}

		const settings = settingsQueries.getAll();
		return settings;
	})

	// List available models for an engine
	.http('models:list', {
		data: t.Object({
			engine: t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen'), t.Literal('pi')])
		}),
		response: t.Array(t.Object({
			engine: t.Object({
				type: t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen'), t.Literal('pi')]),
				provider: t.String(),
				model: t.Object({ id: t.String(), name: t.String() }),
				account: t.Object({ id: t.Number(), name: t.String() }),
			}),
			limit: t.Object({ input: t.Number(), output: t.Number() }),
			modalities: t.Object({
				input: t.Object({ text: t.Boolean(), image: t.Boolean(), audio: t.Boolean(), video: t.Boolean(), pdf: t.Boolean() }),
				output: t.Object({ text: t.Boolean(), image: t.Boolean(), audio: t.Boolean(), video: t.Boolean(), pdf: t.Boolean() }),
			}),
			capabilities: t.Object({
				reasoning: t.Boolean(),
				tools: t.Boolean(),
				structuredOutput: t.Boolean(),
				requiresAuthMode: t.Optional(t.Union([t.Literal('chatgpt'), t.Literal('api_key')])),
			}),
			cost: t.Object({ input: t.Number(), output: t.Number() }),
		}))
	}, async ({ data }) => {
		const engineType: EngineType = data.engine;

		// Uniform path for every engine. Each adapter's getAvailableModels()
		// owns the catalog logic (static array or dynamic fetch); this handler
		// just initialises the engine, asks for the catalog, and registers it
		// in the shared registry so backend callers can resolve models too.
		const engine = await initializeEngine(engineType);
		const models = await engine.getAvailableModels();
		registerModels(engineType, models);
		return models;
	});
