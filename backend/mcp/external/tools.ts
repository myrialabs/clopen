/**
 * External MCP — per-tool exposure control.
 *
 * A user-installed server exposes many tools; not all of them are wanted on
 * every engine. This module owns the small amount of pure logic that decides
 * whether a given tool is exposed — used in two places:
 *
 *   1. The `/mcp/ext/<slug>` proxy bridge (`./proxy.ts`) filters its
 *      `tools/list` (and guards `tools/call`) per engine, so the decision is
 *      enforced ONCE for every engine regardless of whether that engine's SDK
 *      supports a tool allowlist.
 *   2. The Settings tool panel (`backend/ws/mcp/tools.ts`) reads back the same
 *      state to render per-tool + per-engine toggles.
 *
 * The state lives in the `mcp_servers.tool_overrides` JSON column; an absent
 * override means "exposed everywhere" so an empty map is the (all-on) default.
 */

import { ENGINES } from '$shared/constants/engines';
import type { EngineType } from '$shared/types/unified';
import type { McpToolOverride, McpToolOverrides } from '$backend/database/queries';

/** Engines whose external-MCP surface can be filtered (the ones routed through the bridge). */
export const MCP_ENGINES: EngineType[] = ENGINES.map(e => e.type);

/** Parse the raw `tool_overrides` column, tolerating legacy/corrupt JSON. */
export function parseToolOverrides(raw: string | null | undefined): McpToolOverrides {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as McpToolOverrides) : {};
	} catch {
		return {};
	}
}

/**
 * Whether `toolName` is exposed. With `engine` omitted (introspection), only the
 * global `enabled` flag applies; with an engine, the per-engine override is also
 * consulted. Unknown tools (no override entry) are exposed by default.
 */
export function isToolExposed(overrides: McpToolOverrides, toolName: string, engine?: EngineType): boolean {
	const override = overrides[toolName];
	if (!override) return true;
	if (override.enabled === false) return false;
	if (engine && override.engines?.[engine] === false) return false;
	return true;
}

/** Per-tool exposure for the Settings UI, split into two INDEPENDENT controls. */
export interface ToolExposure {
	/** Whole-tool kill switch — `false` hides the tool from every engine. */
	enabled: boolean;
	/**
	 * Per-engine picks, independent of `enabled`. Kept separate so the UI can
	 * distinguish "tool off" from "tool on but hidden from engine X" and so a
	 * per-engine choice survives a master off→on round-trip.
	 */
	engines: Record<EngineType, boolean>;
}

/** Expand a stored (possibly absent) override into the two independent controls. */
export function resolveToolExposure(override: McpToolOverride | undefined): ToolExposure {
	const enabled = override?.enabled !== false;
	const engines = Object.fromEntries(
		MCP_ENGINES.map(engine => [engine, override?.engines?.[engine] !== false])
	) as Record<EngineType, boolean>;
	return { enabled, engines };
}

/**
 * Drop overrides that carry no information (enabled + every engine on) so the
 * stored map only ever contains real restrictions — keeps the column small and
 * makes "any restriction at all?" a simple emptiness check.
 */
export function pruneToolOverrides(overrides: McpToolOverrides): McpToolOverrides {
	const out: McpToolOverrides = {};
	for (const [name, override] of Object.entries(overrides)) {
		const disabledGlobally = override.enabled === false;
		const disabledEngines = Object.entries(override.engines ?? {}).filter(([, on]) => on === false);
		if (!disabledGlobally && disabledEngines.length === 0) continue;
		out[name] = {
			...(disabledGlobally ? { enabled: false } : {}),
			...(disabledEngines.length > 0 ? { engines: Object.fromEntries(disabledEngines) } : {})
		};
	}
	return out;
}
