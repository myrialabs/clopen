/**
 * Pi native MCP wiring.
 *
 * Pi ships its own MCP client (`createMcpExtension`, built on `@earendil-works/pi-mcp`).
 * SDK sessions don't load it by default, so we add it to the resource loader
 * with a Clopen-owned config: the internal `clopen-mcp` bridge plus one bridge
 * per external / approved project server — the same `/mcp` endpoints the other
 * engines use (see `getPiMcpConfig`). Clopen stays the single MCP authority:
 *
 *   - `loadConfig` replaces Pi's own `mcp.json` discovery, which reads the REAL
 *     `~/.pi/agent` (Pi's `getAgentDir()`, not the isolated dir we pass the session).
 *   - Every entry carries the service-token `Authorization` header, so Pi never
 *     starts its OAuth flow; upstream OAuth stays in Clopen's proxy.
 *   - `logPath` / `openUrl` / `updateConfig` keep the extension from writing to
 *     `~/.pi/agent` or opening a browser.
 *
 * Pi names tools `mcp__<server>__<tool>` with every non-`[A-Za-z0-9_]` char
 * turned into `_` (and a hash suffix on collision), so names like
 * `mcp__clopen_mcp__actions` are lossy. The tool's `label` keeps the original
 * `<server>/<tool>`, which {@link resolvePiToolName} maps back to Clopen's
 * canonical `mcp__<namespace>__<tool>`.
 */

import { join } from 'node:path';
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { INTERNAL_BRIDGE_NAMESPACE, resolveOpenCodeToolName } from '../../../mcp';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { getPiAgentDir } from './environment';
import { debug } from '$shared/utils/logger';

/**
 * Pi's MCP extension, fed `servers` (from `getPiMcpConfig`) instead of any
 * `mcp.json` on disk. Pi reports failed connections and config errors only
 * through `ctx.ui.notify`, which is a no-op in an SDK session, so a server that
 * never connected just left its tools missing. Those notices go to the debug
 * log instead.
 */
export async function createPiMcpExtension(servers: Record<string, McpServerConfig>): Promise<ExtensionFactory> {
	const { createMcpExtension } = await loadEngineSdk<typeof import('@earendil-works/pi-coding-agent')>('pi', '@earendil-works/pi-coding-agent');
	const factory = createMcpExtension({
		loadConfig: () => ({
			servers: Object.entries(servers).map(([name, config]) => ({ name, config, source: 'clopen', scope: 'extension' })),
			autoEnableCodemode: false,
			errors: [],
		}),
		logPath: join(getPiAgentDir(), 'mcp.log'),
		openUrl: (url) => debug.warn('mcp', `Pi MCP asked to open ${url}; ignored (Clopen owns MCP sign-in)`),
		updateConfig: () => { /* servers come from Clopen's DB, not a file */ },
	});
	return (pi) => factory(withLoggedNotices(pi));
}

/** `pi`, whose event handlers get a context with `ui.notify` routed to the debug log. */
function withLoggedNotices(pi: ExtensionAPI): ExtensionAPI {
	const on = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
		pi.on(event as never, ((payload: unknown, ctx: ExtensionContext) => handler(payload, withLoggedNotify(ctx))) as never)) as ExtensionAPI['on'];
	return new Proxy(pi, { get: (target, key) => key === 'on' ? on : bound(target, key) });
}

function withLoggedNotify(ctx: ExtensionContext): ExtensionContext {
	const notify = (message: string, type: 'info' | 'warning' | 'error' = 'info') => {
		if (type === 'info') debug.log('mcp', `Pi MCP: ${message}`);
		else debug.warn('mcp', `Pi MCP: ${message}`);
	};
	const ui = new Proxy(ctx.ui, { get: (target, key) => key === 'notify' ? notify : bound(target, key) });
	return new Proxy(ctx, { get: (target, key) => key === 'ui' ? ui : bound(target, key) });
}

/** A property read off the real object, methods bound to it (they may use private fields). */
function bound(target: object, key: string | symbol): unknown {
	const value: unknown = Reflect.get(target, key, target);
	return typeof value === 'function' ? value.bind(target) : value;
}

/**
 * Map a Pi tool name to Clopen's canonical form. MCP tools resolve through
 * their `<server>/<tool>` label; everything else passes through unchanged.
 */
export function resolvePiToolName(session: AgentSession | null, name: string): string {
	if (!name.startsWith('mcp__') || !session) return name;
	const label = session.getToolDefinition(name)?.label;
	const slash = label?.indexOf('/') ?? -1;
	if (!label || slash <= 0) return name;
	const server = label.slice(0, slash);
	const tool = label.slice(slash + 1);
	if (server === INTERNAL_BRIDGE_NAMESPACE) return resolveOpenCodeToolName(tool) ?? `mcp__${server}__${tool}`;
	return `mcp__${server}__${tool}`;
}
