/**
 * Single-file share links ("Share via Link / QR Code" in the File Explorer).
 *
 * A share token grants bearer access to exactly ONE file via the public route
 * `GET /api/files/shared?share=<token>` — no session, no login on the
 * receiving device. The link is built against the same public origin Remote
 * Access resolves (`share:ensure-origin`: configured domain, current origin,
 * or a Cloudflare quick tunnel), so no new reachability system is needed.
 *
 * Security model (mirrors the invite/device-code flows):
 * - Only the raw token's SHA-256 hash is kept; the raw token is returned once,
 *   at creation time, and is embedded in the shared URL.
 * - Creation reuses the exact project-scoped path check the download route
 *   uses (`requireFilePathAccessFor`), so a user can only share files they
 *   could download themselves. Directories are rejected.
 * - Tokens expire (finite TTL) and are single-file bound: the HTTP route
 *   resolves the path from the token and ignores any caller-supplied path,
 *   so a link can never be retargeted at another file.
 * - Tokens are ONE-TIME: the first successful open consumes the token, and
 *   every later open of the same link fails closed (used or expired).
 */

import { stat } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';
import { generateFileShareToken, hashToken } from '../auth/tokens';
import { requireFilePathAccessFor } from '../ws/files/path-access';

/** How long a file-share link stays usable after creation. */
export const FILE_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Streaming continuation window after the single use is consumed.
 *
 * A video/audio player does not fetch the file once: it issues many byte-range
 * requests (initial probe, buffering, seek, replay) against the same URL. The
 * one-time rule still applies to *opens* — any full (non-range) GET after the
 * first open fails closed — but range requests keep working for this window so
 * an already-open player can seek and replay. Copy-paste/reopen/rescan always
 * issues a full GET, so it always hits the gone message, even inside the window.
 */
export const FILE_SHARE_DRAIN_MS = 30 * 60 * 1000;

export interface FileShareEntry {
	/** Canonical absolute path of the shared file (resolved at creation). */
	filePath: string;
	createdBy: string | null;
	createdAt: string;
	expiresAt: string;
}

const shares = new Map<string, FileShareEntry>();

/** Consumed tokens still inside the streaming continuation window. */
interface DrainedShare {
	filePath: string;
	createdBy: string | null;
	consumedAt: number;
}

const draining = new Map<string, DrainedShare>();

function pruneDraining(): void {
	const cutoff = Date.now() - FILE_SHARE_DRAIN_MS;
	for (const [hash, record] of draining) {
		if (record.consumedAt <= cutoff) {
			draining.delete(hash);
		}
	}
}

function pruneExpired(): void {
	const now = Date.now();
	for (const [hash, entry] of shares) {
		if (new Date(entry.expiresAt).getTime() <= now) {
			shares.delete(hash);
		}
	}
	pruneDraining();
}

/**
 * Mint a share token for a single file. The caller must already be
 * authenticated over the WebSocket; access is enforced with the same
 * project-scoped policy as the download route.
 */
export async function createFileShareLink(
	requestedPath: string,
	role: string | null,
	userId: string | null
): Promise<{ shareToken: string; expiresAt: string }> {
	const resolvedPath = await requireFilePathAccessFor(requestedPath, role, userId);

	const stats = await stat(resolvedPath).catch(() => null);
	if (!stats) {
		throw new Error('File not found');
	}
	if (stats.isDirectory()) {
		throw new Error('Cannot share a folder — compress it first');
	}

	pruneExpired();

	const shareToken = generateFileShareToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + FILE_SHARE_TTL_MS).toISOString();
	shares.set(hashToken(shareToken), {
		filePath: resolvedPath,
		createdBy: userId,
		createdAt: now.toISOString(),
		expiresAt
	});
	debug.log('file', `File share created for ${resolvedPath}`);
	return { shareToken, expiresAt };
}

/** Resolve a raw share token to its entry, or throw when unknown/expired. */
export function resolveFileShareLink(shareToken: string): FileShareEntry {
	pruneExpired();
	const entry = shares.get(hashToken(shareToken));
	if (!entry) {
		throw new Error('Invalid or expired share link');
	}
	return entry;
}

/**
 * One-time consume: resolve the token AND delete it atomically (single
 * synchronous get+delete, so exactly one concurrent request can win).
 * Throws when the token is unknown, already used, or expired — i.e. every
 * open after the first successful one fails closed.
 *
 * Consumption moves the token into the draining set (not oblivion) so the
 * already-open player's byte-range requests keep working until the
 * continuation window lapses. Full reopens never consult that set.
 */
export function consumeFileShareLink(shareToken: string): FileShareEntry {
	const entry = resolveFileShareLink(shareToken);
	const hash = hashToken(shareToken);
	shares.delete(hash);
	draining.set(hash, {
		filePath: entry.filePath,
		createdBy: entry.createdBy,
		consumedAt: Date.now()
	});
	pruneDraining();
	debug.log('file', `File share consumed for ${entry.filePath}`);
	return entry;
}

/**
 * Look up a consumed-but-draining token for a byte-range continuation.
 * Returns null when the token was never consumed or the window lapsed —
 * full reopens must never call this; they fail closed via resolve/consume.
 */
export function getDrainingShare(shareToken: string): { filePath: string; createdBy: string | null } | null {
	pruneDraining();
	const record = draining.get(hashToken(shareToken));
	if (!record) return null;
	return { filePath: record.filePath, createdBy: record.createdBy };
}

/**
 * Revoke a share token. The creator or an admin may revoke; returns false
 * when the token is unknown (already expired/revoked).
 */
export function revokeFileShareLink(
	shareToken: string,
	role: string | null,
	userId: string | null
): boolean {
	const hash = hashToken(shareToken);
	const entry = shares.get(hash);
	if (!entry) return false;
	if (role !== 'admin' && entry.createdBy !== userId) {
		throw new Error('Access denied');
	}
	shares.delete(hash);
	return true;
}
