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
	/** Issues, pull requests and CI — the hosting view of the Git panel. */
	'work',
	'deployments',
	'database',
	'worktree-branching',
	'notifications',
	/**
	 * Control Clopen from a chat app — sessions, projects, models, engine
	 * accounts, MCP servers, skills and the rest of the control catalog
	 * (`backend/control/`), with questions and finished runs reported back to
	 * the chat. Distinct from `notifications`, which only sends.
	 */
	'control',
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
	/** Borrowed from a CLI already signed in on this machine — `gh`, `glab`, `tea`, or git's own keychain. */
	| 'cli'
	| 'none';

/**
 * Sign-in facts for a provider that hosts git repositories.
 *
 * Declared per provider so the connect dialog can offer every method the
 * service supports, in the order that costs the user least: a CLI that is
 * already signed in, then a browser sign-in, then a pasted token.
 */
export interface IntegrationHostingInfo {
	/** `github.com`, `gitlab.com` — null when the service is self-hosted only. */
	defaultHost: string | null;
	/** True when a server URL may (or must) be given. */
	selfHosted: boolean;
	/** True when the server URL is required — there is no cloud default. */
	requiresServerUrl: boolean;
	/** The CLI whose login can be borrowed, when there is one. */
	cli: 'gh' | 'glab' | 'tea' | null;
	/** OAuth device flow is available (a client id may still be needed). */
	deviceFlow: boolean;
	/** OAuth authorization-code + PKCE in the browser is available. */
	browserFlow: boolean;
	/**
	 * Whether Clopen ships a client id for the cloud host. Without one, OAuth
	 * needs the user's own app's client id — always true for a self-hosted
	 * server, which Clopen has no app on.
	 */
	hasBundledClientId: boolean;
	/** Where to register an OAuth app on this service, for the "use your own" hint. */
	oauthAppUrl: string | null;
	/** Scopes Clopen asks for, shown before the user consents. */
	scopes: string[];
}

/** Hosting facts about one connected account — never the credential. */
export interface IntegrationAccountHosting {
	host: string;
	login: string | null;
	/** The CLI this account re-reads its token from on every use, when linked. */
	linkedCli: 'gh' | 'glab' | 'tea' | null;
	/** When an OAuth token stops working without a refresh. Null = no expiry. */
	expiresAt: string | null;
}

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
	/**
	 * The provider's own dashboard.
	 *
	 * Separate from `docsUrl`, which points at where a CREDENTIAL is created.
	 * This is where the things Clopen cannot manage actually live — an
	 * organisation Neon has no API for, a billing plan — so a surface that has
	 * to say "do this at the vendor" can offer the trip instead of describing it.
	 */
	consoleUrl?: string;
	authMethod: IntegrationAuthMethod;
	/** Every way this provider can be connected, preferred first. Always includes `authMethod`. */
	authMethods: IntegrationAuthMethod[];
	credentialFields: IntegrationCredentialField[];
	capabilities: IntegrationCapability[];
	defaultCapabilities: IntegrationCapability[];
	/** Present for providers that host git repositories. */
	hosting?: IntegrationHostingInfo;
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
	/** Present for accounts of a git hosting provider. */
	hosting?: IntegrationAccountHosting;
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
