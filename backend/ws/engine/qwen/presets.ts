/**
 * Qwen Code Provider Presets Handler
 *
 * Exposes the static preset catalog (DashScope CN/INTL, OpenRouter, Fireworks)
 * to the frontend so it can render the picker without importing backend
 * modules directly.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	QWEN_PROVIDER_PRESETS,
	DEFAULT_QWEN_PRESET,
} from '../../../engine/adapters/qwen/presets';

const PRESET_LITERALS = t.Union([
	t.Literal('dashscope-cn'),
	t.Literal('dashscope-intl'),
	t.Literal('openrouter'),
	t.Literal('fireworks'),
]);

export const qwenPresetsHandler = createRouter()
	.http('engine:qwen-presets-list', {
		data: t.Object({}),
		response: t.Object({
			presets: t.Array(t.Object({
				id: PRESET_LITERALS,
				name: t.String(),
				defaultBaseUrl: t.String(),
				docsUrl: t.Optional(t.String()),
			})),
			defaultPreset: PRESET_LITERALS,
		})
	}, async () => {
		return {
			presets: QWEN_PROVIDER_PRESETS,
			defaultPreset: DEFAULT_QWEN_PRESET,
		};
	});
