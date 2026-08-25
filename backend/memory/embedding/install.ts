/**
 * On-demand fetch of the embedding artifact.
 *
 * The artifact is REQUIRED, not an enhancement. Retrieval fuses BM25 with vector
 * similarity, and the lexical half alone cannot answer a question phrased
 * differently from the memory that holds the answer — asking in Indonesian about
 * a memory written in English shares no terms at all, so BM25 returns nothing and
 * the feature looks broken rather than degraded. Memory therefore reports itself
 * NOT READY until this lands, and recall stays off until it does.
 *
 * Recording is deliberately exempt from that gate (see `readiness.ts`): the turns
 * a user has while the download runs are usually the ones that set up a project,
 * and losing them to a progress bar would be the worse failure. Extraction keeps
 * writing, the indexer backfills vectors the moment the artifact arrives, and
 * nothing recorded in the meantime is lost.
 *
 * Every file is checksum-verified before it is put in place, and the whole set is
 * written to a temporary directory that is only renamed once complete. A partial
 * or corrupted table would not crash anything; it would quietly return wrong
 * neighbours forever, which is far harder to notice than a failed download.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { debug } from '$shared/utils/logger';
import { embedder } from './embedder';
import {
	EMBEDDING_ASSETS,
	EMBEDDING_VERSION,
	assetUrl,
	getEmbeddingModelDir,
	getStackEmbeddingDir,
	hasPinnedChecksums,
	isEmbeddingArtifactInstalled
} from './paths';

/**
 * Why a download did not produce a usable artifact.
 *
 * The distinction that matters is whether WAITING can fix it. A network error
 * can; a checksum mismatch cannot, and retrying one forever would hammer the
 * release endpoint while telling the user nothing. `unpublished` is the same
 * kind of dead end from the other direction — no release exists for this version
 * yet, so there is nothing to retry against until the build is upgraded.
 */
export type EmbeddingFailureKind = 'network' | 'corrupt' | 'unpublished';

export interface EmbeddingInstallStatus {
	phase: 'idle' | 'downloading' | 'installed' | 'waiting' | 'failed';
	attempts: number;
	error: string | null;
	failure: EmbeddingFailureKind | null;
	/** True when no further automatic attempt is scheduled. */
	permanent: boolean;
	/** ISO time of the next automatic attempt, when one is scheduled. */
	nextAttemptAt: string | null;
	receivedBytes: number;
	totalBytes: number;
}

/** Total payload, known up front from the pinned sizes. */
const TOTAL_BYTES = EMBEDDING_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);

/**
 * Backoff for a retryable failure: 15s, 45s, 2m, 6m, then every 15 minutes.
 *
 * The tail is deliberately not unbounded. The common cause is a laptop that is
 * offline or on a captive portal, and that resolves on a timescale of minutes —
 * a schedule that backs off to hours would leave memory unready long after the
 * network came back, with no signal to the user that anything was still waiting.
 */
const BACKOFF_MS = [15_000, 45_000, 120_000, 360_000];
const MAX_BACKOFF_MS = 900_000;

let status: EmbeddingInstallStatus = {
	phase: 'idle',
	attempts: 0,
	error: null,
	failure: null,
	permanent: false,
	nextAttemptAt: null,
	receivedBytes: 0,
	totalBytes: TOTAL_BYTES
};

let inFlight: Promise<boolean> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let onChange: (() => void) | null = null;

/** Notified whenever the status changes, so the UI can follow a live download. */
export function onEmbeddingInstallChange(listener: (() => void) | null): void {
	onChange = listener;
}

export function getEmbeddingInstallStatus(): EmbeddingInstallStatus {
	return { ...status };
}

function setStatus(patch: Partial<EmbeddingInstallStatus>): void {
	status = { ...status, ...patch };
	onChange?.();
}

/**
 * Ensure the artifact is present and loaded. Resolves to whether the embedder
 * ended up ready. Idempotent and safe to call at every startup.
 *
 * `force` restarts a schedule that has given up, which is what the Settings
 * button and a fresh startup both need — otherwise a permanent failure would
 * stay permanent for the life of the process even after the user fixed it.
 */
export function ensureEmbeddingArtifact(force = false): Promise<boolean> {
	if (inFlight) return inFlight;
	if (force) {
		clearRetry();
		setStatus({ attempts: 0, permanent: false, nextAttemptAt: null });
	}
	inFlight = run().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

function clearRetry(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

/** Schedule the next attempt, or stop and say why. */
function scheduleRetry(kind: EmbeddingFailureKind, message: string): void {
	// Neither of these can be fixed by trying again: the bytes at the far end are
	// wrong, or there are no bytes at the far end at all.
	if (kind === 'corrupt' || kind === 'unpublished') {
		setStatus({ phase: 'failed', error: message, failure: kind, permanent: true, nextAttemptAt: null });
		return;
	}

	const delay = BACKOFF_MS[Math.min(status.attempts - 1, BACKOFF_MS.length - 1)] ?? MAX_BACKOFF_MS;
	const wait = Math.min(delay, MAX_BACKOFF_MS);
	setStatus({
		phase: 'waiting',
		error: message,
		failure: kind,
		permanent: false,
		nextAttemptAt: new Date(Date.now() + wait).toISOString()
	});

	clearRetry();
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void ensureEmbeddingArtifact();
	}, wait);
	// A pending retry must never hold the process open on its own.
	retryTimer.unref?.();
}

async function run(): Promise<boolean> {
	if (isEmbeddingArtifactInstalled()) {
		const loaded = await embedder.load();
		if (loaded) {
			clearRetry();
			setStatus({
				phase: 'installed',
				error: null,
				failure: null,
				permanent: false,
				nextAttemptAt: null,
				receivedBytes: TOTAL_BYTES
			});
		}
		return loaded;
	}

	if (!hasPinnedChecksums()) {
		// No release has been cut for this version yet. Downloading without a
		// checksum to compare against would be verification theatre, so it is
		// skipped and said plainly.
		const message = `No published embedding artifact for v${EMBEDDING_VERSION}`;
		debug.log(
			'memory',
			`${message} — build one locally with: bun scripts/build-embedding-artifact.ts --install`
		);
		scheduleRetry('unpublished', message);
		return false;
	}

	const target = getEmbeddingModelDir();
	const staging = `${target}.partial`;

	setStatus({ phase: 'downloading', attempts: status.attempts + 1, error: null, receivedBytes: 0 });

	try {
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });

		let downloaded = 0;
		for (const asset of EMBEDDING_ASSETS) {
			const url = assetUrl(asset.file);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);

			const bytes = new Uint8Array(await response.arrayBuffer());
			const digest = Bun.SHA256.hash(bytes, 'hex');
			if (digest !== asset.sha256) {
				// Thrown apart from the network errors below, because no amount of
				// retrying turns the wrong bytes into the right ones.
				throw new CorruptAssetError(
					`checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`
				);
			}

			await writeFile(join(staging, asset.file), bytes);
			downloaded += bytes.byteLength;
			setStatus({ receivedBytes: downloaded });
		}

		await mkdir(getStackEmbeddingDir(), { recursive: true });
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);

		debug.log('memory', `Embedding artifact v${EMBEDDING_VERSION} installed (${(downloaded / 1e6).toFixed(1)} MB)`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		const kind: EmbeddingFailureKind = error instanceof CorruptAssetError ? 'corrupt' : 'network';
		debug.warn('memory', `Embedding artifact download failed (${kind})`, error);
		scheduleRetry(kind, message);
		return false;
	}

	embedder.unload();
	const loaded = await embedder.load();
	if (loaded) {
		clearRetry();
		setStatus({
			phase: 'installed',
			error: null,
			failure: null,
			permanent: false,
			nextAttemptAt: null,
			receivedBytes: TOTAL_BYTES
		});
	} else {
		// The files verified but the table would not parse — the artifact on the
		// release is not what this build expects, which waiting cannot fix.
		scheduleRetry('corrupt', embedder.status().error ?? 'artifact failed to load');
	}
	return loaded;
}

/** Marker so the catch can tell a bad payload from a bad connection. */
class CorruptAssetError extends Error {}
