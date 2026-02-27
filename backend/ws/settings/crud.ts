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
import { settingsQueries } from '../../lib/database/queries';
import { initializeEngine } from '../../lib/engine';
import { CLAUDE_CODE_MODELS, registerModels } from '$shared/constants/engines';
import type { EngineType } from '$shared/types/engine';

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
			engine: t.Union([t.Literal('claude-code'), t.Literal('opencode')])
		}),
		response: t.Array(t.Object({
			id: t.String(),
			engine: t.Union([t.Literal('claude-code'), t.Literal('opencode')]),
			modelId: t.String(),
			name: t.String(),
			provider: t.String(),
			description: t.String(),
			capabilities: t.Array(t.String()),
			contextWindow: t.Number(),
			category: t.Union([t.Literal('latest'), t.Literal('stable'), t.Literal('legacy')]),
			recommended: t.Optional(t.Boolean())
		}))
	}, async ({ data }) => {
		const engineType: EngineType = data.engine;

		// Claude Code models are static
		if (engineType === 'claude-code') {
			return CLAUDE_CODE_MODELS;
		}

		// Dynamic engines: initialize and fetch models
		const engine = await initializeEngine(engineType);
		const models = await engine.getAvailableModels();

		// Register fetched models in the shared registry
		registerModels(engineType, models);

		return models;
	});
