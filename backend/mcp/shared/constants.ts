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
