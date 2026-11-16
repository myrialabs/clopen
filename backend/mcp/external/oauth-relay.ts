/**
 * The callback relay — so a service can be connected from a phone.
 *
 * A sign-in link sends the owner's browser back to a redirect URL. On this
 * computer that is `localhost`; on a phone (Telegram, Remote Access) localhost
 * is the phone itself, and the sign-in silently goes nowhere. The relay is a
 * tiny server on its own port that answers exactly one path — the OAuth
 * callback — put on the internet with a Cloudflare quick tunnel only while a
 * sign-in is pending, and closed once none is.
 *
 * Clopen itself is never exposed: the relay does not proxy anything, it only
 * hands a code to the same handler as `/api/mcp/oauth/callback`, which accepts
 * nothing but a `state` Clopen issued and has not used. That keeps it safe
 * even when Clopen runs with "No login".
 */

import { tunnelKit } from '$backend/tunnel/tunnel-config';
import { debug } from '$shared/utils/logger';
import { handleOAuthCallback } from './oauth-callback';
import { pendingFlowCount } from './oauth';

const PATH = '/oauth/callback';
/** Close the relay this long after it was last needed, whatever happens. */
const IDLE_MS = 30 * 60_000;

interface Relay {
	server: ReturnType<typeof Bun.serve>;
	port: number;
	url: string;
	timer: ReturnType<typeof setTimeout>;
}

let relay: Relay | null = null;
let starting: Promise<string | null> | null = null;

function keepAlive(current: Relay): void {
	clearTimeout(current.timer);
	current.timer = setTimeout(() => void stopRelay(), IDLE_MS);
}

async function stopRelay(): Promise<void> {
	const current = relay;
	relay = null;
	if (!current) return;
	clearTimeout(current.timer);
	await tunnelKit.quick.stop(current.port).catch(() => {});
	current.server.stop(true);
	debug.log('mcp', 'OAuth callback relay closed');
}

/**
 * The public redirect URL for a sign-in, starting the relay when needed.
 * Null when no tunnel can be made (offline, cloudflared unavailable) — the
 * caller then uses the local callback.
 */
export function relayRedirectUri(): Promise<string | null> {
	if (relay) {
		keepAlive(relay);
		return Promise.resolve(relay.url);
	}
	starting ??= (async () => {
		const server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch(request) {
				const url = new URL(request.url);
				if (request.method !== 'GET' || url.pathname !== PATH) return new Response('Not found', { status: 404 });
				return handleOAuthCallback(Object.fromEntries(url.searchParams));
			}
		});
		const port = server.port;
		try {
			if (!port) throw new Error('no port');
			await tunnelKit.bin.ensure();
			const { publicUrl } = await tunnelKit.quick.start({ service: port, autoStopMinutes: 0 });
			if (!publicUrl) throw new Error('no public URL');
			const current: Relay = { server, port, url: `${publicUrl.replace(/\/$/, '')}${PATH}`, timer: setTimeout(() => {}, 0) };
			relay = current;
			keepAlive(current);
			debug.log('mcp', `OAuth callback relay open at ${current.url}`);
			return current.url;
		} catch (error) {
			server.stop(true);
			debug.warn('mcp', 'The OAuth callback relay could not start; using the local callback:', error);
			return null;
		}
	})().finally(() => {
		starting = null;
	});
	return starting;
}

/** Close the relay once no sign-in is waiting for it. */
export function closeRelayWhenIdle(): void {
	if (relay && pendingFlowCount() === 0) void stopRelay();
}

/** The relay's current URL, if it is open. */
export function currentRelayUrl(): string | null {
	return relay?.url ?? null;
}
