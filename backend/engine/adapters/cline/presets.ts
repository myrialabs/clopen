/**
 * Cline provider catalog.
 *
 * Cline ships a built-in provider catalog (Anthropic, OpenAI, Google, Bedrock,
 * Mistral, the Cline account, OpenAI-compatible, …). Rather than hardcode them,
 * we enumerate the catalog from `@cline/llms` (`getAllProviders`) and derive each
 * provider's auth shape from `getProviderConfigFields` + `isOAuthProvider`, then
 * expose the result to the login picker via `engine:cline-presets-list`.
 *
 * The wire types (`ClineProviderPreset`, `ClineAuthMode`, `ClineCredentialField`)
 * live in `shared/types/unified/engine.ts` so the frontend stays typed without
 * importing `$backend`.
 */

import { Llms, getProviderConfigFields, isOAuthProvider } from '@cline/sdk';
import type { ClineAuthMode, ClineCredentialField, ClineProviderPreset } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';

export type { ClineAuthMode, ClineCredentialField, ClineProviderPreset };

/** Where to obtain an API key, keyed by Cline provider id (best-effort hints). */
const API_KEY_URLS: Record<string, string> = {
	anthropic: 'https://console.anthropic.com/settings/keys',
	openai: 'https://platform.openai.com/api-keys',
	'openai-native': 'https://platform.openai.com/api-keys',
	gemini: 'https://aistudio.google.com/apikey',
	google: 'https://aistudio.google.com/apikey',
	mistral: 'https://console.mistral.ai/api-keys',
	deepseek: 'https://platform.deepseek.com/api_keys',
	openrouter: 'https://openrouter.ai/keys',
	groq: 'https://console.groq.com/keys',
	xai: 'https://console.x.ai',
	together: 'https://api.together.ai/settings/api-keys',
	fireworks: 'https://fireworks.ai/account/api-keys',
	cerebras: 'https://cloud.cerebras.ai',
};

/** Human labels for the OAuth (sign-in) option, keyed by provider id. */
const OAUTH_LABELS: Record<string, string> = {
	cline: 'Sign in with Cline',
	anthropic: 'Sign in with Claude Pro/Max',
	'claude-code': 'Sign in with Claude Code',
};

/** Human-readable field labels, keyed by the Cline config-field key. */
const FIELD_LABELS: Record<string, string> = {
	apiKey: 'API key',
	baseUrl: 'Base URL',
	azureApiVersion: 'Azure API version',
	awsRegion: 'AWS region',
	awsProfile: 'AWS profile',
	gcpProjectId: 'GCP project ID',
	gcpRegion: 'GCP region',
	sapClientId: 'SAP client ID',
	sapClientSecret: 'SAP client secret',
	sapTokenUrl: 'SAP token URL',
	sapResourceGroup: 'SAP resource group',
	sapDeploymentId: 'SAP deployment ID',
};

const SECRET_FIELDS = new Set(['apiKey', 'sapClientSecret']);

/**
 * Map a provider's `getProviderConfigFields` shape into the wire
 * `ClineCredentialField[]` the account form renders.
 */
export function getClineProviderFields(providerId: string): ClineCredentialField[] {
	const config = getProviderConfigFields(providerId);
	const out: ClineCredentialField[] = [];
	for (const [key, req] of Object.entries(config.fields ?? {})) {
		if (!req) continue;
		const role: ClineCredentialField['role'] = key === 'apiKey' ? 'apiKey' : key === 'baseUrl' ? 'baseUrl' : 'field';
		out.push({
			key,
			label: req.label ?? FIELD_LABELS[key] ?? key,
			secret: SECRET_FIELDS.has(key),
			role,
			...(req.placeholder ? { placeholder: req.placeholder } : {}),
			...(req.optional ? { optional: true } : {}),
		});
	}
	// Providers with no declared fields still accept an API key.
	if (out.length === 0) {
		out.push({ key: 'apiKey', label: 'API key', secret: true, role: 'apiKey', placeholder: 'sk-…' });
	}
	return out;
}

let presetsCache: ClineProviderPreset[] | null = null;

/**
 * Enumerate Cline's providers and their supported auth modes. Cached — the
 * catalog is static per process. Returns `[]` on any failure (mirrors the
 * dynamic-catalog `[]`-on-failure contract so the picker renders empty rather
 * than a stale list).
 */
export async function getClineProviderPresets(): Promise<ClineProviderPreset[]> {
	if (presetsCache) return presetsCache;
	try {
		const presets: ClineProviderPreset[] = [];
		for (const provider of await Llms.getAllProviders()) {
			const config = getProviderConfigFields(provider.id);
			const oauth = isOAuthProvider(provider.id) || config.authMethod === 'oauth';
			const fields = getClineProviderFields(provider.id);
			const hasApiKey = config.authMethod === 'api-key' || config.authMethod === 'local' || fields.some(f => f.role === 'apiKey');

			const authModes: ClineAuthMode[] = [];
			if (hasApiKey) authModes.push('api_key');
			if (oauth) authModes.push('oauth');
			if (authModes.length === 0) authModes.push('api_key');

			presets.push({
				id: provider.id,
				name: provider.name || provider.id,
				authModes,
				...(authModes.includes('api_key') ? { fields } : {}),
				...(OAUTH_LABELS[provider.id] ? { oauthLabel: OAUTH_LABELS[provider.id] } : {}),
				...(API_KEY_URLS[provider.id] ? { apiKeyUrl: API_KEY_URLS[provider.id] } : {}),
			});
		}
		presets.sort((a, b) => a.name.localeCompare(b.name));
		presetsCache = presets;
		return presets;
	} catch (error) {
		debug.warn('engine', `Cline presets: failed to enumerate providers: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
