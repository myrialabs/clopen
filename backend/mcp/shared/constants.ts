/**
 * Shared MCP namespace constants
 *
 * Clopen exposes MCP tools from two distinct sources. Their namespace keys are
 * kept disjoint on purpose so the two systems never collide:
 *
 *   - INTERNAL (custom tools defined in `backend/mcp/internal/servers/` via
 *     `defineServer()`). Every non-Claude engine consumes them through the
 *     single remote-HTTP bridge whose namespace key is
 *     `INTERNAL_BRIDGE_NAMESPACE` (`clopen-mcp`). The `clopen` prefix is what
 *     marks a namespace as internal.
 *
 *   - EXTERNAL (servers the user installs from the official MCP registry, see
 *     `backend/mcp/external/`). Each external server uses its BARE slug as the
 *     namespace key — no prefix. Tools surface as `mcp__<slug>__<tool>`.
 *
 * Invariants:
 *   - The `clopen` prefix is reserved for internal namespaces; external slugs
 *     must never start with it (enforced by `slugifyRegistryName`).
 *   - External slugs are unique and only contain `[a-z0-9-]`.
 */

/** Namespace key of the internal remote-HTTP MCP bridge (`/mcp`). */
export const INTERNAL_BRIDGE_NAMESPACE = 'clopen-mcp';

/**
 * Per-tool-call timeout (ms) Clopen hands to non-Claude engines for the
 * internal `/mcp` bridge. MCP tools can legitimately run far longer than the
 * engines' short defaults (e.g. OpenCode's 5s), so we make this effectively
 * unlimited — a finite-but-huge value because the engine SDKs expose no
 * "disable" sentinel and feed this straight into setTimeout, which overflows
 * above 2^31-1 ms (~24.8 days). 7 days is beyond any real tool call yet safely
 * under that ceiling.
 *
 * NOTE: this only governs the engine's CLIENT-side request timeout. The Clopen
 * HTTP server's own idle timeout is disabled separately on the `/mcp` route via
 * Bun's `server.timeout(request, 0)` (see backend/index.ts) — both layers must
 * be lifted or a long tool call still dies with MCP error -32001.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Prefix reserved for internal MCP namespaces (marks a key as "ours"). */
export const INTERNAL_PREFIX = 'clopen';

/**
 * Namespace key for an external server. External servers use their bare slug
 * directly — no prefix. Kept as a function so call sites read intent and a
 * future scheme change has a single seam.
 */
export function externalNamespace(slug: string): string {
	return slug;
}

/** True when a namespace key belongs to an internal server/bridge. */
export function isInternalNamespace(namespace: string): boolean {
	return namespace === INTERNAL_BRIDGE_NAMESPACE || namespace.startsWith(`${INTERNAL_PREFIX}-`);
}

/**
 * Sanitize an arbitrary registry server name into a safe, unique slug usable
 * as an MCP namespace segment. Registry names are reverse-DNS
 * (`io.github.foo/bar`) and contain `.` / `/` / uppercase which are illegal
 * in the `mcp__<server>__<tool>` form. We lowercase, replace every
 * non-`[a-z0-9]` run with a single `-`, and trim leading/trailing dashes.
 *
 * `io.github.foo/bar-baz` → `io-github-foo-bar-baz`
 *
 * The `clopen` prefix is reserved for internal namespaces — if a slug would
 * start with it, we prefix `x-` so external keys can never shadow the internal
 * bridge or an internal server.
 */
export function slugifyRegistryName(name: string): string {
	let slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) slug = 'server';
	if (slug === INTERNAL_PREFIX || slug.startsWith(`${INTERNAL_PREFIX}-`) || slug.startsWith(INTERNAL_PREFIX)) {
		slug = `x-${slug}`;
	}
	return slug;
}
