/**
 * Qwen Code Provider Presets
 *
 * Each Qwen account picks one preset. The preset bundles a default base URL
 * used both for the streaming endpoint and for the OpenAI-compatible
 * `/models` discovery call (see `./models.ts`).
 *
 * The wire-format types (`QwenProviderPresetId`, `QwenProviderPreset`) live in
 * `shared/types/unified/engine.ts` so the frontend stays typed without
 * importing from `$backend`. Runtime values are exposed to the frontend via
 * the `engine:qwen-presets-list` WS endpoint.
 */

import type {
	QwenProviderPresetId,
	QwenProviderPreset,
} from '$shared/types/unified';

export type { QwenProviderPresetId, QwenProviderPreset };

export const QWEN_PROVIDER_PRESETS: QwenProviderPreset[] = [
	{
		id: 'dashscope-intl',
		name: 'DashScope (International)',
		defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
	},
	{
		id: 'dashscope-cn',
		name: 'DashScope (China)',
		defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		docsUrl: 'https://openrouter.ai/keys',
	},
	{
		id: 'fireworks',
		name: 'Fireworks AI',
		defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
		docsUrl: 'https://fireworks.ai/account/api-keys',
	},
];

export const DEFAULT_QWEN_PRESET: QwenProviderPresetId = 'dashscope-intl';

export const getQwenPreset = (id: QwenProviderPresetId | string): QwenProviderPreset | undefined =>
	QWEN_PROVIDER_PRESETS.find(p => p.id === id);
