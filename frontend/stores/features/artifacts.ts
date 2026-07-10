/**
 * Shared artifact types for the Settings → Commands / Subagents editors.
 *
 * Model and tool overrides are per-engine: a map keyed by `EngineType` where an
 * absent entry means "inherit" (model) or "all tools" (allowlist) for that
 * engine. Mirrors the backend `EngineMap`.
 */

import type { EngineType } from '$shared/types/unified';

export type EngineValueMap = Partial<Record<EngineType, string>>;
