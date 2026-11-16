/**
 * The end of an MCP sign-in: the provider redirects the owner's browser here
 * with a code, which is exchanged for tokens (stored against the server).
 *
 * Served in two places by the same handler: Clopen's own HTTP layer
 * (`/api/mcp/oauth/callback`, for a sign-in opened on this computer) and the
 * callback relay (`oauth-relay.ts`, for one opened anywhere else). It accepts
 * only a `state` Clopen issued and has not used yet, so reaching it from the
 * internet gives nothing.
 */

import { debug } from '$shared/utils/logger';
import { completeAuthorization } from './oauth';

function page(title: string, body: string): Response {
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.1rem}p{color:#94a3b8;font-size:.9rem}</style></head><body><div><h1>${title}</h1><p>${body}</p><script>setTimeout(()=>window.close(),2500)</script></div></body></html>`,
		{ headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
	);
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export async function handleOAuthCallback(query: { code?: string; state?: string; error?: string }): Promise<Response> {
	const { code, state, error } = query;
	if (error) return page('Sign-in failed', `The service said: ${escape(String(error)).slice(0, 200)}. Close this tab and ask Clopen to try again.`);
	if (!code || !state) return page('Sign-in failed', 'The sign-in link was incomplete. Close this tab and ask Clopen to try again.');
	try {
		const serverId = await completeAuthorization(state, code);
		// A connection asked for from a chat ("connect Notion"): close its card and let that chat carry on.
		void import('$backend/assistant/connect').then(({ onServiceConnected }) => onServiceConnected(serverId)).catch(() => {});
		void import('./oauth-relay').then(({ closeRelayWhenIdle }) => closeRelayWhenIdle()).catch(() => {});
		return page('Connected', 'All set. You can close this tab — Clopen carries on.');
	} catch (err) {
		debug.warn('mcp', 'OAuth callback failed:', err);
		return page('Sign-in failed', `${escape(err instanceof Error ? err.message : 'Unknown error')}. Close this tab and ask Clopen to try again.`);
	}
}
