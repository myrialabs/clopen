/**
 * Third-party integrations.
 *
 * A connected account is a CREDENTIAL WITH CAPABILITIES, stored once in
 * `integration_accounts`. Rows on other surfaces are projections derived from
 * it, and nothing downstream of a projection needs to know accounts exist.
 *
 *   registry/     what Clopen can connect to, declared in code
 *   accounts.ts   connect / reconfigure / disconnect
 *   projections/  the derived rows, and the adopt-and-release rules
 *   webhooks/     the signed inbound endpoint
 *   health.ts     account health, and the health of secrets at rest
 */

export {
	PROVIDERS,
	getProvider,
	listProviderInfo,
	toProviderInfo,
	defaultCapabilitiesOf,
	defineProvider
} from './registry';
export type { IntegrationProvider, McpPreset, WebhookSpec } from './registry';

export { integrationAccounts, toAccountInfo } from './accounts';
export type { ConnectInput } from './accounts';

export { reproject, releaseAll, registerProjector, projectableCapabilities } from './projections';
export type { Projector, ProjectionContext, ProjectionResult } from './projections';

export { handleInboundDelivery, onWebhook, MAX_BODY_BYTES } from './webhooks/gateway';
export type { WebhookEvent, WebhookSubscriber } from './webhooks/gateway';
export { verifySignature } from './webhooks/verify';

export { checkAccountHealth, getSecretsHealth, registerAccountProbe } from './health';
export type { AccountProbe } from './health';
