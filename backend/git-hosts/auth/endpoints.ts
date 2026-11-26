/**
 * OAuth endpoints per service, and the two token requests every flow ends in:
 * exchanging a grant for a token, and refreshing one.
 *
 * Every client here is PUBLIC — a device-flow or PKCE client with no secret —
 * because a secret compiled into a self-hosted app is readable by anyone who
 * installs it. That rules out Bitbucket's OAuth, which requires one.
 */

import type { GitHostKind } from '$shared/types/git-hosting';
import { HostApiError } from '../http';
import { normaliseBaseUrl } from '../urls';

export interface DeviceEndpoints {
	deviceCode: string;
	token: string;
}

export interface BrowserEndpoints {
	authorize: string;
	token: string;
}

const CLOUD_ROOT: Partial<Record<GitHostKind, string>> = {
	github: 'https://github.com',
	gitlab: 'https://gitlab.com'
};

/** The web root OAuth lives under — the server URL, or the cloud default. */
export function oauthRoot(provider: GitHostKind, baseUrl: string | undefined): string {
	return normaliseBaseUrl(baseUrl) || CLOUD_ROOT[provider] || '';
}

export function deviceEndpoints(provider: GitHostKind, baseUrl: string | undefined): DeviceEndpoints | null {
	const root = oauthRoot(provider, baseUrl);
	if (!root) return null;
	if (provider === 'github') {
		return { deviceCode: `${root}/login/device/code`, token: `${root}/login/oauth/access_token` };
	}
	if (provider === 'gitlab') {
		return { deviceCode: `${root}/oauth/authorize_device`, token: `${root}/oauth/token` };
	}
	return null;
}

export function browserEndpoints(provider: GitHostKind, baseUrl: string | undefined): BrowserEndpoints | null {
	const root = oauthRoot(provider, baseUrl);
	if (!root) return null;
	if (provider === 'gitea') {
		return { authorize: `${root}/login/oauth/authorize`, token: `${root}/login/oauth/access_token` };
	}
	if (provider === 'gitlab') {
		return { authorize: `${root}/oauth/authorize`, token: `${root}/oauth/token` };
	}
	return null;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	/** ISO time the access token stops working, or null when it does not expire. */
	expiresAt: string | null;
	scopes: string[] | null;
}

/** The fields every token endpoint returns, in any of the shapes they return them. */
interface TokenWire {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
}

export class OAuthGrantError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'OAuthGrantError';
	}
}

/**
 * POST a grant to a token endpoint.
 *
 * GitHub answers errors with HTTP 200 and an `error` field, GitLab with 400
 * and the same field, so success is decided by the body, not the status.
 */
export async function requestToken(url: string, form: Record<string, string>): Promise<TokenSet> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'clopen'
			},
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(20_000)
		});
	} catch (error) {
		throw new HostApiError(`Could not reach the sign-in server: ${error instanceof Error ? error.message : String(error)}`, 0, 'error');
	}

	let body: TokenWire = {};
	try {
		body = (await response.json()) as TokenWire;
	} catch {
		throw new HostApiError(`The sign-in server answered HTTP ${response.status} without a token`, response.status, 'error');
	}

	if (body.error || !body.access_token) {
		throw new OAuthGrantError(body.error ?? 'invalid_response', body.error_description || body.error || 'No access token was returned');
	}

	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token ?? null,
		expiresAt: typeof body.expires_in === 'number' && body.expires_in > 0
			? new Date(Date.now() + body.expires_in * 1000).toISOString()
			: null,
		scopes: body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : null
	};
}

/** The token endpoint a stored refresh token goes back to. */
export function refreshEndpoint(provider: GitHostKind, baseUrl: string | undefined): string | null {
	return deviceEndpoints(provider, baseUrl)?.token ?? browserEndpoints(provider, baseUrl)?.token ?? null;
}
