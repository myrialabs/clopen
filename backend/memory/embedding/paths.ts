/**
 * Where the on-demand embedding artifact lives, and what it is made of.
 *
 * The weights are DATA, not code, so they are fetched from a GitHub release
 * asset rather than installed as an npm package. npm would have meant publishing
 * a package this repository is itself the source of, and a 44 MB payload whose
 * only consumer resolves it by path anyway.
 *
 * Files land in `~/.clopen/stack/embedding/<version>/`, alongside the engine
 * SDKs — a clopen-managed directory, so a globally installed clopen never
 * touches the user's global store or their projects. Versioning the directory
 * means a new artifact is a fresh download rather than an in-place overwrite,
 * so a half-finished fetch can never leave a mixed set of files behind.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getClopenDir } from '$backend/utils/paths';

/**
 * Artifact version. Also the release tag: `embedding-v<version>`.
 *
 * Bump this together with the checksums below whenever the artifact is rebuilt —
 * they are what makes a download verifiable, so a mismatched pair is worse than
 * no pin at all.
 */
export const EMBEDDING_VERSION = '0.0.1';

/** GitHub repository the release assets are published from. */
const RELEASE_REPO = 'myrialabs/clopen';

export interface EmbeddingAsset {
	file: string;
	/** SHA-256 of the file, hex. Emitted by `scripts/build-embedding-artifact.ts`. */
	sha256: string;
	bytes: number;
}

/**
 * The four files that make up the artifact, with the checksums the build script
 * emitted. Downloads are verified against these before anything is written into
 * place: the payload is executed as weights, not code, but a corrupted table
 * would silently poison every similarity score rather than fail loudly.
 *
 * `hasPinnedChecksums()` reports whether they are real, so the installer refuses
 * to download rather than pretending to verify against an empty hash.
 */
export const EMBEDDING_ASSETS: EmbeddingAsset[] = [
	{ file: 'model.bin', sha256: '777801e24cd154ee1c87fe62b9e6a2a7afecf1c695bb0e29d0a0ee4d7fd76f87', bytes: 39000016 },
	{ file: 'tokenizer.json', sha256: 'fe59f0916aab8a9b73daadb1b9b3ed9a38b81f46de4848c3fdbe10123b97f828', bytes: 5411414 },
	{ file: 'tokenizer_config.json', sha256: 'bd0e8c3a56aeac5078a6445e6b04425cd17b41bcc8d382ae925b5dbca287f8eb', bytes: 1898 },
	{ file: 'manifest.json', sha256: '584e9e64e7baa33bbb244e281791736238144d68b226dc09c3fc9a7b27a21ce7', bytes: 214 }
];

/** True once real checksums have been pinned for the current version. */
export function hasPinnedChecksums(): boolean {
	return EMBEDDING_ASSETS.every(asset => asset.sha256.length === 64);
}

/** Download URL for one asset of the current version. */
export function assetUrl(file: string): string {
	return `https://github.com/${RELEASE_REPO}/releases/download/embedding-v${EMBEDDING_VERSION}/${file}`;
}

/** Managed directory holding every installed artifact version. */
export function getStackEmbeddingDir(): string {
	return join(getClopenDir(), 'stack', 'embedding');
}

/** Directory holding the current version's `model.bin`, tokenizer and manifest. */
export function getEmbeddingModelDir(): string {
	return join(getStackEmbeddingDir(), EMBEDDING_VERSION);
}

export interface EmbeddingManifest {
	source: string;
	sourceLicense: string;
	rows: number;
	dim: number;
	quantization: string;
	vocabLimit: number;
}

/**
 * Whether a usable artifact is present. Checks every payload file rather than
 * just the directory, so a half-finished install reads as missing instead of
 * failing later during load.
 */
export function isEmbeddingArtifactInstalled(): boolean {
	const dir = getEmbeddingModelDir();
	return EMBEDDING_ASSETS.every(asset => existsSync(join(dir, asset.file)));
}

/** Parsed manifest of the installed artifact, or null when unavailable. */
export function readEmbeddingManifest(): EmbeddingManifest | null {
	try {
		return JSON.parse(readFileSync(join(getEmbeddingModelDir(), 'manifest.json'), 'utf8')) as EmbeddingManifest;
	} catch {
		return null;
	}
}
