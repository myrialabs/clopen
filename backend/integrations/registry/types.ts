/**
 * Provider registry types.
 *
 * A provider is a DECLARATION, not code: what it is called, how it
 * authenticates, which credential fields it needs, which capabilities it can
 * offer, and — when it offers agent tools — how the stored credential maps onto
 * the env vars or headers the upstream MCP server expects.
 *
 * Providers carry NO icon field. The brand mark is keyed by provider id in
 * `shared/constants/tool-icons.ts`, so a provider whose artwork has not been
 * added yet falls back to a generic glyph instead of blocking the entry.
 */

import type {
	IntegrationAuthMethod,
	IntegrationCapability,
	IntegrationCategory,
	IntegrationCredentialField
} from '$shared/types/integrations';
import type { McpTransport } from '$backend/database/queries';

/**
 * How a stored credential lands on an MCP server row.
 *
 * `env` is the stdio path and `headers` the remote path. A preset declares one
 * or the other (or both, for a server that accepts either), and the projector
 * writes only what the transport actually uses.
 */
export interface McpPreset {
	/** Slug of the projected `mcp_servers` row. Also the namespace engines see. */
	slug: string;
	name: string;
	description: string;
	transport: McpTransport;

	/** stdio */
	command?: string;
	args?: string[];

	/** http / sse */
	url?: string;

	/** Credential field name → environment variable name. */
	env?: Record<string, string>;

	/**
	 * Credential field name → header name, optionally wrapped.
	 * `format` receives the credential value as `{value}` — `Bearer {value}`
	 * being the common case.
	 */
	headers?: Record<string, { name: string; format?: string }>;

	/** Values that carry no secret and are written verbatim. */
	staticEnv?: Record<string, string>;
	staticHeaders?: Record<string, string>;
}

/** How an inbound delivery from this provider is authenticated. */
export interface WebhookSpec {
	/**
	 * Signature scheme.
	 *   - `hmac-sha256`: hex or base64 HMAC of the raw body, in `signatureHeader`.
	 *   - `none`: no signature — only valid for providers that offer none, and
	 *     the gateway still requires the account to be connected and enabled.
	 */
	scheme: 'hmac-sha256' | 'none';
	/** Header carrying the signature. */
	signatureHeader?: string;
	/** Optional prefix the provider puts in front of the digest, e.g. `sha256=`. */
	signaturePrefix?: string;
	/** Encoding of the digest in the header. */
	digestEncoding?: 'hex' | 'base64';
	/** Header carrying the provider's unique delivery id, used for replay rejection. */
	deliveryIdHeader?: string;
	/** Credential field holding the shared secret. */
	secretField: string;
}

export interface IntegrationProvider {
	/** Machine id. `[a-z0-9-]` only — it keys the brand mark and the hook URL. */
	id: string;
	name: string;
	category: IntegrationCategory;
	description: string;
	docsUrl?: string;
	authMethod: IntegrationAuthMethod;
	credentialFields: IntegrationCredentialField[];
	/** Everything this provider is able to offer. */
	capabilities: IntegrationCapability[];
	/** Turned on at connect time. Defaults to every capability when omitted. */
	defaultCapabilities?: IntegrationCapability[];
	/** Required when `capabilities` includes `agent-tools`. */
	mcp?: McpPreset;
	/** Required when `capabilities` includes `inbound-events`. */
	webhook?: WebhookSpec;
}
