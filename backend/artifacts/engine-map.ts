/**
 * Per-engine value maps for artifacts (command/subagent model & tool overrides).
 *
 * Stored in the DB as a JSON object keyed by `EngineType` ('claude-code',
 * 'opencode', …). An absent/blank entry means "inherit" (model) or "all tools"
 * (tool allowlist) for that engine. Keyed by `EngineType` — the frontend's
 * canonical engine id — so the editor round-trips without translation; the sync
 * layer maps its `ArtifactEngine` ('claude') to `EngineType` ('claude-code')
 * when reading a value (see `artifactEngineToType`).
 */

import type { EngineType } from '$shared/types/unified';
import type { ArtifactEngine } from './types';

export type EngineMap = Partial<Record<EngineType, string>>;

/** Parse a stored JSON map, tolerating null/blank/corrupt values. */
export function parseEngineMap(json: string | null | undefined): EngineMap {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object') return {};
		const out: EngineMap = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof v === 'string' && v.trim()) out[k as EngineType] = v.trim();
		}
		return out;
	} catch {
		return {};
	}
}

/** Serialize a map to JSON, dropping blank entries so `{}` means "no overrides". */
export function stringifyEngineMap(map: EngineMap | undefined): string {
	if (!map) return '{}';
	const out: EngineMap = {};
	for (const [k, v] of Object.entries(map)) {
		if (typeof v === 'string' && v.trim()) out[k as EngineType] = v.trim();
	}
	return JSON.stringify(out);
}

/** The sync layer iterates `ArtifactEngine`; resolve the map key for one engine. */
export function artifactEngineToType(engine: ArtifactEngine): EngineType {
	return engine === 'claude' ? 'claude-code' : engine;
}

/** Normalise a tool allowlist string (comma/space separated) into `a, b, c` (null when empty). */
export function normalizeToolList(tools?: string | null): string | null {
	if (!tools) return null;
	const list = tools.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
	return list.length ? list.join(', ') : null;
}
