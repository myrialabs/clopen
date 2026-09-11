/**
 * Third-party integrations — shared vocabulary.
 *
 * A connected account is NOT a feature. It is a credential with capabilities.
 * Settings → Integrations is where you connect; what an integration DOES lives
 * in the surface that owns that kind of work. These types are the contract
 * between the two, and they are shared because the hub renders provider
 * metadata the backend registry declares.
 */

/**
 * What an account can offer, and therefore which surface it projects onto.
 *
 * The full set is declared here from the start so a provider can honestly say
 * what it supports, but only the surfaces that exist can be projected. Today
 * that is `agent-tools`; each later surface registers its own projector.
 */
export const INTEGRATION_CAPABILITIES = [
	'agent-tools',
	/** Issues, pull requests and CI — the Issues & PRs surface. */
	'work',
	'deployments',
	'database',
	'worktree-branching',
	'notifications',
	'inbound-events'
] as const;

export type IntegrationCapability = typeof INTEGRATION_CAPABILITIES[number];

/** How the credential is obtained. */
export type IntegrationAuthMethod =
	| 'api-key'
	| 'oauth-device'
	| 'oauth-code'
	| 'mcp-oauth'
	| 'connection-string'
	| 'none';

/**
 * Declared as a const array rather than a bare union so the WebSocket schema can
 * be generated from it. A `t.String()` there would widen `category` back to
 * `string` on the client and quietly break every lookup keyed by it.
 */
export const INTEGRATION_CATEGORIES = [
	'source-control',
	'issues',
	'deployment',
	'database',
	'observability',
	'chat',
	'research',
	'design',
	'developer-services',
	'secrets'
] as const;

export type IntegrationCategory = typeof INTEGRATION_CATEGORIES[number];

/** One field of a provider's credential, as rendered by the connect dialog. */
export interface IntegrationCredentialField {
	/** Key inside the account's credentials object. */
	name: string;
	label: string;
	placeholder?: string;
	help?: string;
	isSecret: boolean;
	isRequired: boolean;
}

/** Health of a connected account, mirroring the MCP probe vocabulary. */
export type IntegrationStatus = 'unknown' | 'ok' | 'needs_auth' | 'needs_config' | 'error';

/** A provider as the hub sees it. No icon field — the brand mark is keyed by id. */
export interface IntegrationProviderInfo {
	id: string;
	name: string;
	category: IntegrationCategory;
	description: string;
	docsUrl?: string;
	authMethod: IntegrationAuthMethod;
	credentialFields: IntegrationCredentialField[];
	capabilities: IntegrationCapability[];
	defaultCapabilities: IntegrationCapability[];
	/** True when connecting projects an MCP server row. */
	providesAgentTools: boolean;
	/** True when the provider can receive inbound webhooks. */
	acceptsWebhooks: boolean;
}

/** A connected account as the hub sees it. Credential VALUES never cross this line. */
export interface IntegrationAccountInfo {
	id: string;
	provider: string;
	label: string;
	projectId: string | null;
	authMethod: IntegrationAuthMethod;
	/** Which credential fields currently hold a value — never the values themselves. */
	configuredFields: string[];
	capabilities: IntegrationCapability[];
	status: IntegrationStatus;
	statusDetail: string | null;
	checkedAt: string | null;
	isEnabled: boolean;
	createdAt: string;
	updatedAt: string;
	/** Surfaces this account currently owns a row on. */
	projections: IntegrationProjectionInfo[];
}

export interface IntegrationProjectionInfo {
	capability: IntegrationCapability;
	targetKind: IntegrationTargetKind;
	targetId: string;
	/** True when the row existed before the account did and will be handed back on disconnect. */
	adopted: boolean;
}

/** Surfaces a capability can project onto. One entry per row in the architecture table. */
export type IntegrationTargetKind = 'mcp_server' | 'db_client_connection';

/**
 * Secrets-at-rest health, surfaced as a banner in the hub.
 *
 * A non-zero count means the active key cannot open values that are in the
 * database — almost always a restored backup meeting a freshly generated key.
 */
export interface SecretsHealth {
	/** Where the active master key came from. */
	keySource: 'env' | 'file';
	/** Fingerprint of the active key — matches the stamp inside every envelope. */
	keyFingerprint: string;
	/** Values the active key could not open since process start. */
	failureCount: number;
	lastFailureAt: string | null;
	/** Fingerprints seen on values we could not open. */
	unknownKeyFingerprints: string[];
	/** Declared secret columns still holding plaintext. */
	unsealedColumns: { table: string; column: string; count: number }[];
}
