/**
 * Memory Graph configuration.
 *
 * Split across two settings screens on purpose, mirroring how Artifacts works:
 * the MODEL lives in Settings → Model → Memory next to the other model choices,
 * and the BEHAVIOUR lives in Settings → Infrastructure → Memory. They answer different questions
 * ("which model writes memories" vs "what should memory do"), and putting them
 * on one page made both harder to find.
 *
 * The model only runs episodic extraction, after a turn has finished streaming
 * and once the session has gone quiet (see `extract/scheduler.ts`). Nothing a
 * user waits on calls a model: retrieval is BM25 plus a local lookup table plus
 * SQL. That is why a slow model is acceptable here and would not be on the read
 * path.
 */

import { settingsQueries } from '$backend/database/queries/settings-queries';
import { debug } from '$shared/utils/logger';
import type { EngineType } from '$shared/types/unified';

export interface MemoryModelConfig {
	engine: EngineType;
	providerSlug?: string;
	modelId: string;
	accountId?: number;
}

export interface MemoryConfig {
	/** Master switch: off means no recording, no retrieval, no injection. */
	enabled: boolean;
	/** Record the files and symbols each turn touches, read from the disk diff. */
	recordCode: boolean;
	/** Summarise finished turns into memories using `model`. */
	recordMemories: boolean;
	/** Hand relevant memories to the agent automatically at the start of a turn. */
	autoRecall: boolean;
	/** Model used for episodic extraction; null leaves memories unrecorded. */
	model: MemoryModelConfig | null;
}

/**
 * THERE IS NO "HOW MUCH TO RECALL" SETTING, and its absence is deliberate.
 *
 * It was a character budget first, which did not bound what it claimed to —
 * measured, its lowest setting produced a block 79% over the number chosen, and
 * its highest silently undershot because the corpus ran out. Replacing it with a
 * count of memories fixed the arithmetic and left the real problem: relevance is
 * not uniform across turns. Six is too many for "ok, continue" and too few for a
 * turn that touches a subject the graph knows a great deal about, and no fixed
 * number can be right for both.
 *
 * The block now takes hits while they are still close to the best one for THAT
 * query and stops when they fall away (see `RELATIVE_FLOOR` in context.ts), so
 * the count follows the question. A hard ceiling remains, in code, as a cost
 * backstop rather than as a control anyone is asked to reason about.
 */
const KEYS = {
	enabled: 'memory_enabled',
	recordCode: 'memory_record_code',
	recordMemories: 'memory_record_memories',
	autoRecall: 'memory_auto_recall',
	model: 'memory_model'
} as const;

function readBoolean(key: string, fallback: boolean): boolean {
	const row = settingsQueries.get(key);
	return row ? row.value === 'true' : fallback;
}

export function getMemoryConfig(): MemoryConfig {
	let model: MemoryModelConfig | null = null;
	const raw = settingsQueries.get(KEYS.model)?.value;
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as MemoryModelConfig;
			if (parsed?.engine && parsed?.modelId) model = parsed;
		} catch {
			debug.warn('memory', 'memory_model setting is not valid JSON; memory recording disabled');
		}
	}

	return {
		enabled: readBoolean(KEYS.enabled, true),
		recordCode: readBoolean(KEYS.recordCode, true),
		recordMemories: readBoolean(KEYS.recordMemories, true),
		autoRecall: readBoolean(KEYS.autoRecall, true),
		model
	};
}

export function setMemoryConfig(patch: Partial<MemoryConfig>): MemoryConfig {
	if (patch.enabled !== undefined) settingsQueries.set(KEYS.enabled, String(patch.enabled));
	if (patch.recordCode !== undefined) settingsQueries.set(KEYS.recordCode, String(patch.recordCode));
	if (patch.recordMemories !== undefined) settingsQueries.set(KEYS.recordMemories, String(patch.recordMemories));
	if (patch.autoRecall !== undefined) settingsQueries.set(KEYS.autoRecall, String(patch.autoRecall));
	if (patch.model !== undefined) {
		settingsQueries.set(KEYS.model, patch.model ? JSON.stringify(patch.model) : '');
	}
	return getMemoryConfig();
}
