/**
 * The two OAuth sign-ins: the device flow (GitHub, GitLab) and the browser
 * authorization-code flow with PKCE (Gitea/Forgejo, self-managed GitLab).
 *
 * Both are driven from the SERVER. The client starts a flow, shows what the
 * user needs (a code to type, or a page to open), and polls one status. The
 * device code and the PKCE verifier never leave this module — a device code is
 * a credential until it expires, and a verifier is what makes a stolen
 * authorization code worthless.
 *
 * Flows live in memory. A restart mid-sign-in loses the flow, and the dialog
 * reports it as expired; there is nothing durable worth persisting about a
 * code that dies in fifteen minutes.
 */

import { randomBytes } from 'node:crypto';
import type {
	AuthFlowPoll,
	AuthFlowStatus,
	BrowserFlowStart,
	DeviceFlowStart,
	GitHostKind
} from '$shared/types/git-hosting';
import type { IntegrationCapability } from '$shared/types/integrations';
import { getProvider } from '$backend/integrations';
import { SERVER_ENV } from '$backend/utils/env';
import { debug } from '$shared/utils/logger';
import { browserEndpoints, deviceEndpoints, OAuthGrantError, requestToken, type TokenSet } from './endpoints';
import { bundledClientId } from './client-ids';
import { connectHostAccount } from './connect';
import { normaliseBaseUrl } from '../urls';

interface FlowTarget {
	provider: GitHostKind;
	baseUrl: string;
	clientId: string;
	label?: string;
	projectId?: string | null;
	capabilities?: IntegrationCapability[];
	/** Reconnect this account rather than creating one. */
	accountId?: string | null;
}

interface FlowState {
	target: FlowTarget;
	status: AuthFlowStatus;
	accountId: string | null;
	error: string | null;
	expiresAt: number;
	cancel?: () => void;
}

interface DeviceFlow extends FlowState {
	kind: 'device';
	deviceCode: string;
	intervalMs: number;
	tokenUrl: string;
}

interface BrowserFlow extends FlowState {
	kind: 'browser';
	verifier: string;
	redirectUri: string;
	tokenUrl: string;
}

const flows = new Map<string, DeviceFlow | BrowserFlow>();

/** Settled flows are kept this long so a late poll still learns the outcome. */
const SETTLED_TTL_MS = 5 * 60 * 1000;

function newId(): string {
	return randomBytes(18).toString('base64url');
}

function settle(id: string, flow: FlowState, status: AuthFlowStatus, detail: { accountId?: string; error?: string } = {}): void {
	flow.status = status;
	flow.accountId = detail.accountId ?? null;
	flow.error = detail.error ?? null;
	flow.cancel?.();
	setTimeout(() => flows.delete(id), SETTLED_TTL_MS).unref?.();
}

/**
 * The client id for a flow: the user's own app when one was given, Clopen's
 * for the cloud host otherwise. A self-hosted server never falls back to ours
 * — our app does not exist there, and the sign-in page would say so in a way
 * that reads like Clopen is broken.
 */
function resolveClientId(provider: GitHostKind, baseUrl: string, own: string | undefined): string {
	const given = (own ?? '').trim();
	if (given) return given;
	if (!baseUrl) {
		const bundled = bundledClientId(provider);
		if (bundled) return bundled;
		throw new Error('Browser sign-in is not configured for this Clopen build. Use a token, or enter your own OAuth application\'s client id.');
	}
	throw new Error('A self-hosted server needs its own OAuth application. Register one there and enter its client id, or use a token.');
}

function scopesFor(provider: GitHostKind): string[] {
	return getProvider(provider)?.hosting?.scopes ?? [];
}

async function finish(id: string, flow: DeviceFlow | BrowserFlow, tokens: TokenSet): Promise<void> {
	try {
		const { account } = await connectHostAccount({
			provider: flow.target.provider,
			accountId: flow.target.accountId,
			label: flow.target.label,
			projectId: flow.target.projectId,
			capabilities: flow.target.capabilities,
			authMethod: flow.kind === 'device' ? 'oauth-device' : 'oauth-code',
			source: 'oauth',
			fields: {
				token: tokens.accessToken,
				...(flow.target.baseUrl && { baseUrl: flow.target.baseUrl })
			},
			extra: {
				clientId: flow.target.clientId,
				...(tokens.refreshToken && { refreshToken: tokens.refreshToken }),
				...(tokens.expiresAt && { expiresAt: tokens.expiresAt })
			}
		});
		settle(id, flow, 'success', { accountId: account.id });
	} catch (error) {
		settle(id, flow, 'error', { error: error instanceof Error ? error.message : String(error) });
	}
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

interface DeviceCodeWire {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_url?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
	error_description?: string;
}

export async function startDeviceFlow(input: Omit<FlowTarget, 'clientId' | 'baseUrl'> & { baseUrl?: string; clientId?: string }): Promise<DeviceFlowStart> {
	const baseUrl = normaliseBaseUrl(input.baseUrl);
	const endpoints = deviceEndpoints(input.provider, baseUrl);
	if (!endpoints) throw new Error('This service does not support signing in with a code');
	const clientId = resolveClientId(input.provider, baseUrl, input.clientId);

	let wire: DeviceCodeWire;
	try {
		const response = await fetch(endpoints.deviceCode, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'clopen' },
			body: new URLSearchParams({ client_id: clientId, scope: scopesFor(input.provider).join(' ') }).toString(),
			signal: AbortSignal.timeout(20_000)
		});
		wire = (await response.json().catch(() => ({}))) as DeviceCodeWire;
		if (!response.ok && !wire.error) wire.error = `HTTP ${response.status}`;
	} catch (error) {
		throw new Error(`Could not reach the sign-in server: ${error instanceof Error ? error.message : String(error)}`);
	}

	const verificationUri = wire.verification_uri ?? wire.verification_url;
	if (wire.error || !wire.device_code || !wire.user_code || !verificationUri) {
		// The usual cause on a self-hosted server: the application does not have
		// the device grant enabled, or is confidential.
		throw new Error(
			wire.error_description || wire.error
				? `The server refused the sign-in: ${wire.error_description || wire.error}. Check that the OAuth application allows the device flow and is not confidential.`
				: 'The server did not start a sign-in'
		);
	}

	const id = newId();
	const flow: DeviceFlow = {
		kind: 'device',
		target: { ...input, baseUrl, clientId },
		status: 'pending',
		accountId: null,
		error: null,
		expiresAt: Date.now() + (wire.expires_in ?? 900) * 1000,
		deviceCode: wire.device_code,
		intervalMs: Math.max(wire.interval ?? 5, 1) * 1000,
		tokenUrl: endpoints.token
	};
	flows.set(id, flow);
	void pollDevice(id, flow);

	return {
		flowId: id,
		userCode: wire.user_code,
		verificationUri,
		verificationUriComplete: wire.verification_uri_complete ?? null,
		expiresAt: new Date(flow.expiresAt).toISOString(),
		intervalSeconds: flow.intervalMs / 1000
	};
}

/** Ask the token endpoint at the interval the server asked for, until it answers. */
async function pollDevice(id: string, flow: DeviceFlow): Promise<void> {
	let stopped = false;
	flow.cancel = () => { stopped = true; };

	while (!stopped && flow.status === 'pending') {
		await Bun.sleep(flow.intervalMs);
		if (stopped || flow.status !== 'pending') return;
		if (Date.now() > flow.expiresAt) {
			settle(id, flow, 'expired');
			return;
		}
		try {
			const tokens = await requestToken(flow.tokenUrl, {
				client_id: flow.target.clientId,
				device_code: flow.deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
			});
			await finish(id, flow, tokens);
			return;
		} catch (error) {
			if (error instanceof OAuthGrantError) {
				if (error.code === 'authorization_pending') continue;
				// The server is telling us to back off; RFC 8628 says by five seconds.
				if (error.code === 'slow_down') {
					flow.intervalMs += 5000;
					continue;
				}
				if (error.code === 'expired_token') {
					settle(id, flow, 'expired');
					return;
				}
				if (error.code === 'access_denied') {
					settle(id, flow, 'denied');
					return;
				}
			}
			debug.warn('git-hosts', 'Device sign-in failed:', error);
			settle(id, flow, 'error', { error: error instanceof Error ? error.message : String(error) });
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Browser flow (authorization code + PKCE)
// ---------------------------------------------------------------------------

/** Where the service sends the browser back. Registered by the user on their OAuth app. */
export function oauthCallbackUri(): string {
	return `http://localhost:${SERVER_ENV.PORT}/api/integrations/oauth/callback`;
}

async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString('base64url');
}

/** Ten minutes to finish signing in, matching the device flow's window. */
const BROWSER_FLOW_MS = 10 * 60 * 1000;

export async function startBrowserFlow(input: Omit<FlowTarget, 'clientId' | 'baseUrl'> & { baseUrl?: string; clientId?: string }): Promise<BrowserFlowStart> {
	const baseUrl = normaliseBaseUrl(input.baseUrl);
	const endpoints = browserEndpoints(input.provider, baseUrl);
	if (!endpoints) throw new Error('This service does not support signing in through the browser');
	const clientId = resolveClientId(input.provider, baseUrl, input.clientId);

	const id = newId();
	const verifier = randomBytes(48).toString('base64url');
	const redirectUri = oauthCallbackUri();
	const flow: BrowserFlow = {
		kind: 'browser',
		target: { ...input, baseUrl, clientId },
		status: 'pending',
		accountId: null,
		error: null,
		expiresAt: Date.now() + BROWSER_FLOW_MS,
		verifier,
		redirectUri,
		tokenUrl: endpoints.token
	};
	flows.set(id, flow);
	const timer = setTimeout(() => {
		if (flow.status === 'pending') settle(id, flow, 'expired');
	}, BROWSER_FLOW_MS);
	flow.cancel = () => clearTimeout(timer);

	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		// The flow id doubles as the OAuth state: unguessable, single-use, and
		// the key the callback finds the verifier under.
		state: id,
		code_challenge: await challengeOf(verifier),
		code_challenge_method: 'S256',
		scope: scopesFor(input.provider).join(' ')
	});

	return { flowId: id, authorizeUrl: `${endpoints.authorize}?${params.toString()}`, redirectUri };
}

/** Called by the HTTP callback route. Throws with a message for the landing page. */
export async function completeBrowserFlow(state: string, code: string): Promise<void> {
	const flow = flows.get(state);
	if (!flow || flow.kind !== 'browser') throw new Error('This sign-in has expired or was already used');
	if (flow.status !== 'pending') throw new Error('This sign-in has already finished');

	let tokens: TokenSet;
	try {
		tokens = await requestToken(flow.tokenUrl, {
			grant_type: 'authorization_code',
			code,
			client_id: flow.target.clientId,
			redirect_uri: flow.redirectUri,
			code_verifier: flow.verifier
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		settle(state, flow, 'error', { error: message });
		throw new Error(message);
	}
	await finish(state, flow, tokens);
	// `finish` settles the flow; read it back through a widened type, since the
	// narrowing above still believes it is pending.
	const settled = flow as FlowState;
	if (settled.status === 'error') throw new Error(settled.error ?? 'Could not connect the account');
}

/** The browser came back with an error instead of a code. */
export function failBrowserFlow(state: string, error: string): void {
	const flow = flows.get(state);
	if (!flow || flow.status !== 'pending') return;
	settle(state, flow, error === 'access_denied' ? 'denied' : 'error', { error });
}

// ---------------------------------------------------------------------------
// Both
// ---------------------------------------------------------------------------

export function pollFlow(id: string): AuthFlowPoll {
	const flow = flows.get(id);
	if (!flow) return { status: 'expired', accountId: null, error: null };
	if (flow.status === 'pending' && Date.now() > flow.expiresAt) settle(id, flow, 'expired');
	return { status: flow.status, accountId: flow.accountId, error: flow.error };
}

export function cancelFlow(id: string): void {
	const flow = flows.get(id);
	if (!flow) return;
	flow.cancel?.();
	flows.delete(id);
}
