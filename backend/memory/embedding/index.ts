export { embedder, packVector, unpackVector, cosineToPacked, type EmbedderStatus } from './embedder';
export {
	ensureEmbeddingArtifact,
	getEmbeddingInstallStatus,
	onEmbeddingInstallChange,
	type EmbeddingInstallStatus,
	type EmbeddingFailureKind
} from './install';
export { vectorCache } from './vector-cache';
export {
	EMBEDDING_VERSION,
	getStackEmbeddingDir,
	getEmbeddingModelDir,
	isEmbeddingArtifactInstalled,
	readEmbeddingManifest,
	type EmbeddingManifest
} from './paths';
