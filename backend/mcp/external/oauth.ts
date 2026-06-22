/**
 * Centralized MCP OAuth client.
 *
 * Clopen performs the OAuth 2.1 authorization-code + PKCE flow ITSELF (with
 * RFC 8414/9728 discovery and RFC 7591 dynamic client registration), stores the
 * resulting access/refresh tokens in the `mcp_servers.oauth` column, and injects
 * `Authorization: Bearer <token>` into EVERY engine's config. This replaces the
 * old per-engine delegation, where each engine kept its own token store so only
 * OpenCode could sign in and the result never reached Codex/Claude/etc.
 *
 * The redirect lands on Clopen's own stable callback route
 * (`/api/mcp/oauth/callback`), so there is no ephemeral per-flow loopback server
 * to race against — the earlier "localhost:NNNNN refused to connect" failure.
 */

import { debug } from '$shared/utils/logger';
import { SERVER_ENV } from '$backend/utils/env';
import { mcpServerQueries } from '$backend/database/queries';

/** Persisted per-server OAuth state (JSON in `mcp_servers.oauth`). */
export interface OAuthRecord {
	clientId: string;
	clientSecret?: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	redirectUri: string;
	scope?: string;
	resource?: string;
	accessToken?: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires. */
	expiresAt?: number;
}

/** Refresh tokens whose access token expires within this window. */
const REFRESH_SKEW_MS = 60_000;

// In-memory authorization flows awaiting their callback, keyed by `state`.
interface PendingFlow {
	serverId: number;
	codeVerifier: string;
	record: OAuthRecord;
}
const pendingFlows = new Map<string, PendingFlow>();

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export function loadOAuth(serverId: number): OAuthRecord | null {
	const row = mcpServerQueries.getById(serverId);
	if (!row?.oauth) return null;
	try { return JSON.parse(row.oauth) as OAuthRecord; } catch { return null; }
}

function saveOAuth(serverId: number, record: OAuthRecord): void {
	mcpServerQueries.setOAuth(serverId, JSON.stringify(record));
}

export function clearOAuth(serverId: number): void {
	mcpServerQueries.setOAuth(serverId, null);
}

/** The fixed redirect URI served by Clopen's HTTP layer. */
export function oauthRedirectUri(): string {
	return `http://localhost:${SERVER_ENV.PORT}/api/mcp/oauth/callback`;
}

// ---------------------------------------------------------------------------
// PKCE + crypto
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Discovery (RFC 9728 protected-resource → RFC 8414 authorization-server)
// ---------------------------------------------------------------------------

interface DiscoveredAuthServer {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scope?: string;
	resource?: string;
}

/** Pull the `resource_metadata` URL out of a `WWW-Authenticate: Bearer …` header. */
function resourceMetadataFromHeader(wwwAuthenticate?: string): string | null {
	if (!wwwAuthenticate) return null;
	const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/i);
	return match?.[1] ?? null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		return await res.json() as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Resolve the authorization server metadata for a remote MCP `resourceUrl`,
 * preferring the `resource_metadata` hint from its 401 challenge.
 */
export async function discover(resourceUrl: string, wwwAuthenticate?: string): Promise<DiscoveredAuthServer> {
	const origin = new URL(resourceUrl).origin;

	// 1. Protected-resource metadata → authorization server + resource id.
	const prmUrl = resourceMetadataFromHeader(wwwAuthenticate) ?? `${origin}/.well-known/oauth-protected-resource`;
	const prm = await fetchJson(prmUrl);
	const authServers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers as string[] : [];
	const asBase = (authServers[0] ?? origin).replace(/\/$/, '');
	const resource = typeof prm?.resource === 'string' ? prm.resource : undefined;

	// 2. Authorization-server metadata (try OAuth, then OpenID locations).
	const asMeta = await fetchJson(`${asBase}/.well-known/oauth-authorization-server`)
		?? await fetchJson(`${asBase}/.well-known/openid-configuration`);
	if (!asMeta?.authorization_endpoint || !asMeta?.token_endpoint) {
		throw new Error('Server does not advertise an OAuth authorization server');
	}

	const scopesSupported = Array.isArray(asMeta.scopes_supported) ? (asMeta.scopes_supported as string[]).join(' ') : undefined;
	return {
		authorizationEndpoint: asMeta.authorization_endpoint as string,
		tokenEndpoint: asMeta.token_endpoint as string,
		registrationEndpoint: typeof asMeta.registration_endpoint === 'string' ? asMeta.registration_endpoint : undefined,
		scope: scopesSupported,
		resource
	};
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

async function registerClient(registrationEndpoint: string, redirectUri: string, scope?: string): Promise<{ clientId: string; clientSecret?: string }> {
	const res = await fetch(registrationEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000),
		body: JSON.stringify({
			client_name: 'Clopen',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			...(scope ? { scope } : {})
		})
	});
	if (!res.ok) {
		throw new Error(`Dynamic client registration failed (${res.status})`);
	}
	const data = await res.json() as { client_id?: string; client_secret?: string };
	if (!data.client_id) throw new Error('Registration response missing client_id');
	return { clientId: data.client_id, clientSecret: data.client_secret };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

async function postToken(tokenEndpoint: string, params: Record<string, string>, clientSecret?: string): Promise<TokenResponse> {
	const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
	if (clientSecret) {
		headers.Authorization = `Basic ${btoa(`${params.client_id}:${clientSecret}`)}`;
	}
	const res = await fetch(tokenEndpoint, {
		method: 'POST',
		headers,
		signal: AbortSignal.timeout(10_000),
		body: new URLSearchParams(params).toString()
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Token request failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
	}
	return await res.json() as TokenResponse;
}

function withExpiry(record: OAuthRecord, token: TokenResponse): OAuthRecord {
	return {
		...record,
		accessToken: token.access_token,
		refreshToken: token.refresh_token ?? record.refreshToken,
		expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined
	};
}

// ---------------------------------------------------------------------------
// Public flow API
// ---------------------------------------------------------------------------

/**
 * Begin an authorization flow for a server. Discovers + (re)registers a client,
 * remembers the PKCE verifier keyed by `state`, and returns the URL the user
 * must open. Completion arrives at the callback route (or the manual paste).
 */
export async function startAuthorization(serverId: number, resourceUrl: string, wwwAuthenticate?: string): Promise<{ authorizationUrl: string }> {
	const disc = await discover(resourceUrl, wwwAuthenticate);
	const redirectUri = oauthRedirectUri();

	// Reuse a prior registration when present; otherwise register dynamically.
	const existing = loadOAuth(serverId);
	let clientId = existing?.clientId;
	let clientSecret = existing?.clientSecret;
	if (!clientId) {
		if (!disc.registrationEndpoint) throw new Error('Server requires a pre-registered OAuth client (no dynamic registration)');
		({ clientId, clientSecret } = await registerClient(disc.registrationEndpoint, redirectUri, disc.scope));
	}

	const codeVerifier = randomToken(32);
	const codeChallenge = await pkceChallenge(codeVerifier);
	const state = randomToken(16);

	const record: OAuthRecord = {
		clientId,
		clientSecret,
		authorizationEndpoint: disc.authorizationEndpoint,
		tokenEndpoint: disc.tokenEndpoint,
		registrationEndpoint: disc.registrationEndpoint,
		redirectUri,
		scope: disc.scope,
		resource: disc.resource
	};
	pendingFlows.set(state, { serverId, codeVerifier, record });

	const url = new URL(disc.authorizationEndpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	if (disc.scope) url.searchParams.set('scope', disc.scope);
	if (disc.resource) url.searchParams.set('resource', disc.resource);

	debug.log('mcp', `🔐 OAuth flow started for server ${serverId} (state ${state.slice(0, 6)}…)`);
	return { authorizationUrl: url.toString() };
}

/** Whether a `state` belongs to a known pending flow (callback validation). */
export function hasPendingFlow(state: string): boolean {
	return pendingFlows.has(state);
}

/**
 * Exchange the authorization `code` for tokens and persist them. Returns the
 * server id the flow belonged to so callers can refresh the UI.
 */
export async function completeAuthorization(state: string, code: string): Promise<number> {
	const flow = pendingFlows.get(state);
	if (!flow) throw new Error('Unknown or expired authorization state');
	pendingFlows.delete(state);

	const token = await postToken(flow.record.tokenEndpoint, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: flow.record.redirectUri,
		client_id: flow.record.clientId,
		code_verifier: flow.codeVerifier,
		...(flow.record.resource ? { resource: flow.record.resource } : {})
	}, flow.record.clientSecret);

	saveOAuth(flow.serverId, withExpiry(flow.record, token));
	debug.log('mcp', `🔓 OAuth tokens stored for server ${flow.serverId}`);
	return flow.serverId;
}

/**
 * Return a usable access token for a server, refreshing it first if it is about
 * to expire. Returns null when the server has no OAuth or the refresh fails.
 */
export async function getValidAccessToken(serverId: number): Promise<string | null> {
	const record = loadOAuth(serverId);
	if (!record?.accessToken) return null;

	const expiringSoon = record.expiresAt != null && record.expiresAt - Date.now() < REFRESH_SKEW_MS;
	if (expiringSoon && record.refreshToken) {
		try {
			const token = await postToken(record.tokenEndpoint, {
				grant_type: 'refresh_token',
				refresh_token: record.refreshToken,
				client_id: record.clientId,
				...(record.resource ? { resource: record.resource } : {})
			}, record.clientSecret);
			const next = withExpiry(record, token);
			saveOAuth(serverId, next);
			return next.accessToken ?? null;
		} catch (error) {
			debug.warn('mcp', `OAuth refresh failed for server ${serverId}:`, error);
			return record.accessToken; // try the (possibly stale) token rather than nothing
		}
	}
	return record.accessToken;
}

/**
 * Refresh every enabled server's token that is close to expiry. Called at chat
 * stream start so the sync per-engine config builders read fresh tokens.
 */
export async function refreshExpiringExternalOAuth(): Promise<void> {
	for (const row of mcpServerQueries.getEnabled()) {
		if (row.source === 'internal' || !row.oauth) continue;
		await getValidAccessToken(row.id).catch(() => undefined);
	}
}
