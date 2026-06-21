/**
 * Internal MCP service token.
 *
 * The non-Claude engines (Open Code, Codex, Copilot, Qwen) reach the internal
 * tool bridge over HTTP at `http://localhost:<port>/mcp`. That endpoint is
 * auth-protected (`getAuthMode() === 'required'` is the DEFAULT), but the
 * engines run as detached SDKs/subprocesses with no user identity to present —
 * so without a credential their handshake is rejected with 401 and the whole
 * `clopen-mcp` bridge silently disappears (the model reports "no MCP at all").
 *
 * To fix this we mint ONE process-scoped secret at startup. The config builders
 * attach it as `Authorization: Bearer <token>` on every bridge URL, and
 * `remote-server.ts` accepts it as a first-class credential regardless of auth
 * mode. The token only ever lives in memory and is only ever sent to loopback,
 * so it never touches disk or the network.
 *
 * Claude is unaffected: it runs internal servers in-process and never hits the
 * HTTP bridge.
 */

const PREFIX = 'clp_mcp_';

function randomHex(bytes: number): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

let token: string | null = null;

/** The process-scoped MCP bridge token, generated lazily on first use. */
export function getMcpServiceToken(): string {
	if (token === null) {
		token = PREFIX + randomHex(24);
	}
	return token;
}

/**
 * Constant-time check whether `candidate` is the current service token.
 * Returns false before the token has been minted.
 */
export function isMcpServiceToken(candidate: string): boolean {
	if (token === null) return false;
	if (candidate.length !== token.length) return false;
	let diff = 0;
	for (let i = 0; i < candidate.length; i++) {
		diff |= candidate.charCodeAt(i) ^ token.charCodeAt(i);
	}
	return diff === 0;
}
