/**
 * Provider registry — the single source of truth for what Clopen can connect to.
 *
 * Mirrors the internal-MCP `defineServer()` pattern: a provider is added by
 * writing one file under `providers/` and putting it in the array below.
 * Everything else — the hub listing, the connect dialog's fields, the
 * projection, the webhook route — is derived from that declaration.
 */

import context7 from './providers/context7';
import firecrawl from './providers/firecrawl';
import type { IntegrationProvider } from './types';
import type { IntegrationProviderInfo } from '$shared/types/integrations';

export type { IntegrationProvider, McpPreset, WebhookSpec } from './types';
export { defineProvider } from './define';

/** Every declared provider. Add new ones here. */
export const PROVIDERS: readonly IntegrationProvider[] = [
	context7,
	firecrawl
];

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function getProvider(id: string): IntegrationProvider | null {
	return byId.get(id) ?? null;
}

/** Capabilities turned on when an account is first connected. */
export function defaultCapabilitiesOf(provider: IntegrationProvider): IntegrationProvider['capabilities'] {
	return provider.defaultCapabilities ?? provider.capabilities;
}

/** The provider as the hub renders it — declaration minus anything internal. */
export function toProviderInfo(provider: IntegrationProvider): IntegrationProviderInfo {
	return {
		id: provider.id,
		name: provider.name,
		category: provider.category,
		description: provider.description,
		docsUrl: provider.docsUrl,
		authMethod: provider.authMethod,
		credentialFields: provider.credentialFields,
		capabilities: [...provider.capabilities],
		defaultCapabilities: [...defaultCapabilitiesOf(provider)],
		providesAgentTools: provider.capabilities.includes('agent-tools'),
		acceptsWebhooks: provider.capabilities.includes('inbound-events')
	};
}

export function listProviderInfo(): IntegrationProviderInfo[] {
	return PROVIDERS.map(toProviderInfo);
}
