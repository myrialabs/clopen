/**
 * Memory Graph — public surface.
 *
 * One graph holds institutional/episodic memory and structural memory of the
 * codebase together (migration 066), so an agent can ask "what did we decide
 * about X" and "what is connected to Y" of the same store, whichever engine is
 * driving the session.
 *
 * Layout:
 *   embedding/     local static-embedding model, installed on demand
 *   retrieval.ts   BM25 + vector + graph expansion, fused with RRF
 *   indexer.ts     backfills vectors behind writes
 *   extract/       turns work into memory (structural from disk diffs, episodic per turn)
 *   compose.ts     the hand-written path: free text in, reviewed memory out
 *   context.ts     token-budgeted injection at turn start
 *   time.ts        reads SQLite timestamps as the UTC they actually are
 *   redact.ts      keeps credentials out of durable storage
 *   revise.ts      belief revision — duplicates, supersession, entities, feedback
 *   invalidate.ts  ages memories whose code changed underneath them
 *   consolidate.ts compresses clusters of memories into generalisations
 *   retention.ts   the bound on how large the graph may grow
 *   maintenance.ts runs the background jobs when nobody is working
 */

export { retrieve, profileQuery, markConsulted } from './retrieval';
export { redactSecrets, neutralizeForPrompt, containsSecret } from './redact';
export { findRelatedCandidates, findDuplicateCandidates, mergeDuplicate, linkEntities, recordContradictions } from './revise';
export { draftMemory, createMemory } from './compose';
export { invalidateForChanges } from './invalidate';
export { consolidateMemories } from './consolidate';
export { applyRetention } from './retention';
export { startMemoryMaintenance, stopMemoryMaintenance, runMaintenanceNow } from './maintenance';
export { scheduleVectorIndexing, drain as drainVectorIndex, reconcileVectorIndex } from './indexer';
export { embedder, ensureEmbeddingArtifact, isEmbeddingArtifactInstalled, type EmbedderStatus } from './embedding';
export { getMemoryReadiness, type MemoryReadiness, type MemoryBlocker } from './readiness';
export { ensureMemoryModel } from './model';
export { bootstrapMemoryGraph } from './bootstrap';
