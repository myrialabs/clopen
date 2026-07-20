/**
 * Pi provider catalog + `ModelRuntime` factory.
 *
 * Pi ships a large built-in provider catalog (Anthropic, OpenAI, Google,
 * OpenRouter, xAI, …), each supporting API-key auth, OAuth (subscription) auth,
 * or both. Rather than hardcode 30 providers, we enumerate them from a
 * throwaway `ModelRuntime` (`getProviders()` exposes `provider.auth.apiKey` /
 * `provider.auth.oauth`) and expose the result to the login picker via the
 * `engine:pi-presets-list` WS endpoint.
 *
 * The wire types (`PiProviderPreset`, `PiAuthMode`) live in
 * `shared/types/unified/engine.ts` so the frontend stays typed without importing
 * `$backend`.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import type { PiAuthMode, PiCredentialField, PiProviderPreset } from '$shared/types/unified';
import { getPiModelsPath, getPiModelsStorePath } from './environment';
import { debug } from '$shared/utils/logger';

export type { PiAuthMode, PiCredentialField, PiProviderPreset };

/**
 * Per-provider API-key credential fields, shown all at once in the account form.
 * Most providers need just a key; a few need extra provider-scoped config
 * (Cloudflare account/gateway ids, Azure base URL) which pi-ai reads from the
 * credential's `env` map (see providers.md). `role: 'key'` → `credential.key`,
 * `role: 'env'` → `credential.env[key]`.
 */
const DEFAULT_FIELDS: PiCredentialField[] = [
	{ key: 'apiKey', label: 'API key', secret: true, role: 'key', placeholder: 'sk-…' },
];

const PROVIDER_FIELDS: Record<string, PiCredentialField[]> = {
	'cloudflare-workers-ai': [
		{ key: 'apiKey', label: 'API token', secret: true, role: 'key' },
		{ key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', secret: false, role: 'env' },
	],
	'cloudflare-ai-gateway': [
		{ key: 'apiKey', label: 'API token', secret: true, role: 'key' },
		{ key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', secret: false, role: 'env' },
		{ key: 'CLOUDFLARE_GATEWAY_ID', label: 'Gateway ID', secret: false, role: 'env' },
	],
	'azure-openai-responses': [
		{ key: 'apiKey', label: 'API key', secret: true, role: 'key' },
		{ key: 'AZURE_OPENAI_BASE_URL', label: 'Base URL', secret: false, role: 'env', placeholder: 'https://your-resource.openai.azure.com' },
	],
};

/** Credential field schema for an api-key provider (single key by default). */
export function getPiProviderFields(providerId: string): PiCredentialField[] {
	return PROVIDER_FIELDS[providerId] ?? DEFAULT_FIELDS;
}

/**
 * Build a `ModelRuntime` pointed at Clopen's isolated Pi dirs. When `credentials`
 * is provided it becomes the auth source (DB-backed store); otherwise the runtime
 * is credential-less (used only to enumerate provider metadata for the picker).
 *
 * We never pass `authPath`, so Pi never touches the user's real
 * `~/.pi/agent/auth.json` — the DB store is the sole credential source.
 */
export async function createPiRuntime(credentials?: CredentialStore): Promise<ModelRuntime> {
	return ModelRuntime.create({
		...(credentials ? { credentials } : {}),
		modelsPath: getPiModelsPath(),
		modelsStorePath: getPiModelsStorePath(),
	});
}

/** Where to obtain an API key, keyed by pi-ai provider id (best-effort hints). */
const API_KEY_URLS: Record<string, string> = {
	anthropic: 'https://console.anthropic.com/settings/keys',
	openai: 'https://platform.openai.com/api-keys',
	google: 'https://aistudio.google.com/apikey',
	openrouter: 'https://openrouter.ai/keys',
	xai: 'https://console.x.ai',
	groq: 'https://console.groq.com/keys',
	deepseek: 'https://platform.deepseek.com/api_keys',
	mistral: 'https://console.mistral.ai/api-keys',
	together: 'https://api.together.ai/settings/api-keys',
	fireworks: 'https://fireworks.ai/account/api-keys',
	cerebras: 'https://cloud.cerebras.ai',
	nvidia: 'https://build.nvidia.com',
};

/** Human labels for the OAuth (subscription) option, keyed by provider id. */
const OAUTH_LABELS: Record<string, string> = {
	anthropic: 'Sign in with Claude Pro/Max',
	'openai-codex': 'Sign in with ChatGPT (Plus/Pro)',
	'github-copilot': 'Sign in with GitHub Copilot',
	xai: 'Sign in with SuperGrok or X Premium',
	radius: 'Sign in with Radius',
};

let presetsCache: PiProviderPreset[] | null = null;

/**
 * Enumerate Pi's providers and their supported auth modes. Cached — the catalog
 * is static per process. Returns `[]` if the runtime can't be built (mirrors the
 * dynamic-catalog `[]`-on-failure contract).
 */
export async function getPiProviderPresets(): Promise<PiProviderPreset[]> {
	if (presetsCache) return presetsCache;
	try {
		const runtime = await createPiRuntime();
		const presets: PiProviderPreset[] = [];
		for (const provider of runtime.getProviders()) {
			const authModes: PiAuthMode[] = [];
			// An ambient-only api-key provider omits `login`; skip it as an
			// interactive target (nothing for the user to paste) but still expose
			// oauth when present.
			if (provider.auth.apiKey?.login) authModes.push('api_key');
			if (provider.auth.oauth) authModes.push('oauth');
			if (authModes.length === 0) continue;
			presets.push({
				id: provider.id,
				name: provider.name,
				authModes,
				...(authModes.includes('api_key') ? { fields: getPiProviderFields(provider.id) } : {}),
				...(OAUTH_LABELS[provider.id] ? { oauthLabel: OAUTH_LABELS[provider.id] } : {}),
				...(API_KEY_URLS[provider.id] ? { apiKeyUrl: API_KEY_URLS[provider.id] } : {}),
			});
		}
		presets.sort((a, b) => a.name.localeCompare(b.name));
		presetsCache = presets;
		return presets;
	} catch (error) {
		debug.warn('engine', `Pi presets: failed to enumerate providers: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
