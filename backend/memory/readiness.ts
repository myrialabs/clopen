/**
 * Whether memory is actually usable, and what is missing when it is not.
 *
 * Memory has two halves with DIFFERENT prerequisites, and collapsing them into
 * one "enabled" flag is what made the feature feel broken during setup:
 *
 *   RECALL needs the embedding artifact. Retrieval fuses BM25 with vector
 *   similarity, and lexical alone cannot match a question phrased differently
 *   from the memory holding the answer — an Indonesian question against an
 *   English memory shares no terms, so BM25 returns nothing. Half a retriever is
 *   not a degraded retriever, it is a retriever that silently misses.
 *
 *   RECORDING needs a model. It does NOT need the artifact: the indexer
 *   backfills vectors whenever the artifact arrives, so a memory written today
 *   becomes searchable the moment setup finishes.
 *
 * Recording is deliberately NOT gated on recall being ready. The turns a user has
 * while a 44 MB download runs are usually the ones that establish a project, and
 * throwing them away to keep a boolean tidy is the worse failure — they are
 * exactly the memories that would have been worth keeping.
 *
 * `setupRequired` is what the banner reads. It stays true until BOTH halves work,
 * because a user whose memory records but never recalls has a feature that
 * appears to do nothing at all.
 */

import { getMemoryConfig } from './config';
import { embedder, getEmbeddingInstallStatus, type EmbeddingInstallStatus } from './embedding';

export interface MemoryReadiness {
	/** Master switch from Settings → Infrastructure → Memory. */
	enabled: boolean;
	/** Retrieval, automatic injection and the MCP `recall` action. */
	canRecall: boolean;
	/** Episodic extraction from finished turns. */
	canRecord: boolean;
	/** True while anything still needs doing, and what the banner keys on. */
	setupRequired: boolean;
	/** Ordered list of what is missing, most actionable first. */
	blockers: MemoryBlocker[];
	embedding: EmbeddingInstallStatus & { ready: boolean };
	model: { configured: boolean; engine: string | null; modelId: string | null };
}

export type MemoryBlocker = 'embedding' | 'model';

export function getMemoryReadiness(): MemoryReadiness {
	const config = getMemoryConfig();
	const install = getEmbeddingInstallStatus();
	const embeddingReady = embedder.status().ready;
	const modelConfigured = Boolean(config.model?.modelId);

	const blockers: MemoryBlocker[] = [];
	// The artifact comes first: it is the one the user cannot fix by choosing
	// something, so it is the one worth surfacing while it is still downloading.
	if (!embeddingReady) blockers.push('embedding');
	if (!modelConfigured) blockers.push('model');

	return {
		enabled: config.enabled,
		canRecall: config.enabled && embeddingReady,
		canRecord: config.enabled && modelConfigured,
		// Nothing to set up when the whole feature is switched off — a banner
		// nagging about a feature the user deliberately disabled is just noise.
		setupRequired: config.enabled && blockers.length > 0,
		blockers,
		embedding: { ...install, ready: embeddingReady },
		model: {
			configured: modelConfigured,
			engine: config.model?.engine ?? null,
			modelId: config.model?.modelId ?? null
		}
	};
}
