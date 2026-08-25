/**
 * Artifact framework — public facade.
 *
 * The shared capability-matrix foundation used by every engine-artifact feature
 * (Skills, Commands, Subagents, Instructions). See `types.ts` for the model and
 * the reserved `'mcp'` slot rationale.
 */

export type {
	ArtifactEngine,
	ArtifactType,
	ArtifactScope,
	ArtifactFormat,
	ArtifactOwnership,
	ArtifactContext,
	ManagedArtifact,
	DetectedArtifact,
	ArtifactResolution,
	ArtifactMarkers
} from './types';
export { ARTIFACT_ENGINES } from './types';

export { resolveArtifact, isBestEffortTarget, isPromptScopedEngine, PROMPT_SCOPED_ENGINES, memoryFileName } from './matrix';
export { materializeArtifacts } from './sync';
export type { MaterializeInput } from './sync';
export { detectArtifacts, adoptArtifact } from './detect';
export { markersFor, writeManagedBlock, readManagedBlock, stripManagedBlock } from './markers';
export { parseDoc, serializeDoc } from './frontmatter';
export type { ParsedDoc } from './frontmatter';
export { slugify, uniqueSlug, isValidSlug } from './slug';
export { parseEngineMap, stringifyEngineMap, artifactEngineToType, normalizeToolList } from './engine-map';
export type { EngineMap } from './engine-map';
export { generateArtifact } from './generate';
export type { GeneratableType, GenerateModel } from './generate';
