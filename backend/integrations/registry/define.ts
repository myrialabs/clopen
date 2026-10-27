/**
 * `defineProvider()` lives in its own module so a provider file can import it
 * without importing the registry that imports the provider file. The cycle
 * would resolve today thanks to hoisting, but it is the kind of thing that
 * breaks silently the moment someone adds a top-level const to the registry.
 */

import type { IntegrationProvider } from './types';

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validate a provider at module load.
 *
 * These are declaration mistakes, not runtime conditions, so failing loudly at
 * import is right: a provider that claims `agent-tools` without a preset would
 * otherwise present a working connect dialog that silently projects nothing.
 */
export function defineProvider(provider: IntegrationProvider): IntegrationProvider {
	if (!SLUG_PATTERN.test(provider.id)) {
		throw new Error(`Integration provider id "${provider.id}" must match ${SLUG_PATTERN}`);
	}
	if (provider.capabilities.includes('agent-tools') && !provider.mcp) {
		throw new Error(`Integration provider "${provider.id}" offers agent-tools but declares no MCP preset`);
	}
	if (provider.mcp && !SLUG_PATTERN.test(provider.mcp.slug)) {
		throw new Error(`Integration provider "${provider.id}" has an invalid MCP preset slug`);
	}
	if (provider.capabilities.includes('inbound-events') && !provider.webhook) {
		throw new Error(`Integration provider "${provider.id}" accepts inbound events but declares no webhook spec`);
	}
	for (const gate of provider.webhook?.capabilities ?? (provider.webhook ? ['inbound-events' as const] : [])) {
		// The gateway only delivers to accounts holding one of these, so a spec
		// naming one the provider cannot offer would accept nothing through it.
		if (!provider.capabilities.includes(gate)) {
			throw new Error(`Integration provider "${provider.id}" gates its webhook on a capability it does not offer: ${gate}`);
		}
	}
	if (provider.webhook?.scheme === 'header-token' && !provider.webhook.signatureHeader) {
		throw new Error(`Integration provider "${provider.id}" uses a header token but names no header`);
	}
	for (const field of provider.generatedCredentials ?? []) {
		if (provider.credentialFields.some((declared) => declared.name === field)) {
			throw new Error(`Integration provider "${provider.id}" both asks for and generates "${field}"`);
		}
	}
	for (const capability of provider.defaultCapabilities ?? []) {
		if (!provider.capabilities.includes(capability)) {
			throw new Error(`Integration provider "${provider.id}" defaults to a capability it does not offer: ${capability}`);
		}
	}
	return provider;
}
