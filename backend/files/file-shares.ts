/**
 * Shareable single-file links ("Share Link…" in the File Explorer).
 *
 * A share token grants bearer access to exactly ONE file via the public route
 * `GET /api/files/shared?share=<token>` — no session, no login on the
 * receiving device. The link is built against the same public origin Remote
 * Access resolves (`share:ensure-origin`: configured domain, current origin,
 * or a Cloudflare quick tunnel), so no new reachability system is needed.
 *
 * The creator picks two things per link, and the defaults are the strict ones:
 * - one-time (default) or reusable until it lapses;
 * - a short deadline (default {@link DEFAULT_FILE_SHARE_TTL_MINUTES} minutes),
 *   a longer one, or none at all — a link only a revoke can end.
 *
 * Security model (mirrors the invite/device-code flows):
 * - Only the raw token's SHA-256 hash is kept; the raw token is returned once,
 *   at creation time, and is embedded in the shared URL.
 * - Tokens live in SQLite (`file_shares`, migration 080) like device codes, so
 *   a restart does not silently kill links a user already handed out.
 * - Creation reuses the exact project-scoped path check the download route
 *   uses (`requireFilePathAccessFor`), so a user can only share files they
 *   could download themselves. Directories are rejected.
 * - That same check is re-run on every open: if the creator loses access to
 *   the path (removed from the project, project deleted, account deleted),
 *   every link they minted for it stops serving immediately.
 * - Links are single-file bound: the HTTP route resolves the path from the
 *   token and ignores any caller-supplied path, so a link can never be
 *   retargeted at another file.
 * - A one-time link fails closed after its first open; a reusable one fails
 *   closed at its deadline, or when revoked.
 * - Management (list, revoke) is keyed by the row id, never by the token: the
 *   raw token only ever exists in the browser that minted it, so a revoke
 *   keyed on the secret would die with that view.
 */

import { stat } from 'node:fs/promises';
import { basename, relative, isAbsolute, sep } from 'node:path';

import { debug } from '$shared/utils/logger';
import { authQueries, fileShareQueries } from '../database/queries';
import { projectQueries } from '../database/queries/project-queries';
import { worktreeQueries } from '../database/queries/worktree-queries';
import { generateFileShareToken, hashToken } from '../auth/tokens';
import { requireFilePathAccessFor } from '../ws/files/path-access';

/**
 * Default lifetime of a new link, in minutes.
 *
 * Five, matching the register of the other one-shot credentials in this app
 * rather than the register of a download page: the link answers "send me that
 * file now", and a URL that outlives the moment only widens the window in
 * which someone else's chat history still opens it. Longer deadlines — and no
 * deadline at all — are a per-link choice, not the default.
 */
export const DEFAULT_FILE_SHARE_TTL_MINUTES = 5;

/** Upper bound on a chosen deadline (30 days). "Never" is expressed as null. */
export const MAX_FILE_SHARE_TTL_MINUTES = 30 * 24 * 60;

/**
 * Streaming continuation window after a one-time link is consumed.
 *
 * A video/audio player does not fetch the file once: it issues many byte-range
 * requests (initial probe, buffering, seek, replay) against the same URL. The
 * one-time rule still applies to *opens* — any full (non-range) GET after the
 * first open fails closed — but range requests keep working for this window
 * so an already-open player can seek and replay. The window is bound to the
 * client that burned the link (see {@link consumerFingerprint}), so a leaked
 * URL cannot be range-read by anybody else inside it.
 */
export const FILE_SHARE_DRAIN_MS = 30 * 60 * 1000;

export interface FileShareView {
	/** Canonical absolute path of the shared file (resolved at creation). */
	filePath: string;
	createdBy: string;
	oneTime: boolean;
	expiresAt: string | null;
	/** True when a one-time link is burned and this is a continuation. */
	draining: boolean;
}

/** Thrown for every "this link cannot serve bytes" case — the route answers 410. */
export class FileShareGoneError extends Error {
	constructor(message = 'Invalid or expired share link') {
		super(message);
		this.name = 'FileShareGoneError';
	}
}

export interface FileShareOptions {
	/** Burn on the first open. Defaults to true. */
	oneTime?: boolean;
	/**
	 * Minutes until the link lapses, or null for "until revoked". Undefined
	 * falls back to {@link DEFAULT_FILE_SHARE_TTL_MINUTES}.
	 */
	expiresInMinutes?: number | null;
}

/**
 * Stable, non-reversible identifier for the client opening a link.
 *
 * Only used to keep the post-burn continuation window with the player that
 * actually opened the file. It is deliberately coarse (IP + user agent): a
 * different device or browser never matches, while the same player's seek and
 * replay requests always do.
 */
export function consumerFingerprint(ip?: string | null, userAgent?: string | null): string {
	return hashToken(`${ip ?? ''}|${userAgent ?? ''}`);
}

/**
 * Re-run the creator's project-scoped access check against the shared path.
 * A link is only ever as alive as the access that minted it.
 */
async function assertCreatorStillHasAccess(filePath: string, createdBy: string): Promise<void> {
	const user = authQueries.getUserById(createdBy);
	if (!user) {
		throw new FileShareGoneError();
	}
	try {
		await requireFilePathAccessFor(filePath, user.role, user.id);
	} catch {
		throw new FileShareGoneError();
	}
}

/** True when `candidate` sits under `root` (plain prefix test, no symlink walk). */
function isUnder(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface FileShareLocation {
	/** Owning project (or the project a worktree belongs to), when there is one. */
	projectName: string | null;
	/** Worktree the file sits in, when it is not the main tree. */
	worktreeName: string | null;
	/** Path relative to that root, or the absolute path when none contains it. */
	relativePath: string;
}

/**
 * Describe where a shared file lives, so a list of links reads as
 * "clopen · backend/http/files-shared.ts" rather than five rows all called
 * `index.ts`. Falls back to the absolute path when nothing owns it.
 *
 * Separators are normalised to `/` for display — a Windows server would
 * otherwise render a path no one can compare against the Explorer tree.
 */
export function describeShareLocation(filePath: string): FileShareLocation {
	let best: { root: string; projectName: string; worktreeName: string | null } | null = null;

	for (const project of projectQueries.getAll()) {
		if (isUnder(project.path, filePath) && (!best || project.path.length > best.root.length)) {
			best = { root: project.path, projectName: project.name, worktreeName: null };
		}
		for (const worktree of worktreeQueries.getByProjectId(project.id)) {
			if (isUnder(worktree.path, filePath) && (!best || worktree.path.length > best.root.length)) {
				best = { root: worktree.path, projectName: project.name, worktreeName: worktree.name };
			}
		}
	}

	if (!best) {
		return { projectName: null, worktreeName: null, relativePath: filePath.split(sep).join('/') };
	}
	return {
		projectName: best.projectName,
		worktreeName: best.worktreeName,
		relativePath: relative(best.root, filePath).split(sep).join('/')
	};
}

/**
 * Mint a share token for a single file. The caller must already be
 * authenticated over the WebSocket; access is enforced with the same
 * project-scoped policy as the download route.
 */
export async function createFileShareLink(
	requestedPath: string,
	role: string | null,
	userId: string | null,
	options: FileShareOptions = {}
): Promise<{ shareId: string; shareToken: string; oneTime: boolean; expiresAt: string | null }> {
	if (!userId) {
		throw new Error('Access denied');
	}
	const resolvedPath = await requireFilePathAccessFor(requestedPath, role, userId);

	const stats = await stat(resolvedPath).catch(() => null);
	if (!stats) {
		throw new Error('File not found');
	}
	if (stats.isDirectory()) {
		throw new Error('Cannot share a folder — compress it first');
	}

	const oneTime = options.oneTime ?? true;
	const minutes = options.expiresInMinutes === undefined
		? DEFAULT_FILE_SHARE_TTL_MINUTES
		: options.expiresInMinutes;
	if (minutes !== null && (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_FILE_SHARE_TTL_MINUTES)) {
		throw new Error('Invalid expiry');
	}

	sweepStaleFileShares();

	const shareToken = generateFileShareToken();
	const now = new Date();
	const expiresAt = minutes === null ? null : new Date(now.getTime() + minutes * 60_000).toISOString();
	const row = fileShareQueries.create({
		tokenHash: hashToken(shareToken),
		filePath: resolvedPath,
		createdBy: userId,
		oneTime,
		expiresAt,
		createdAt: now.toISOString()
	});
	debug.log('file', `File share created for ${resolvedPath} (${oneTime ? 'one-time' : 'reusable'})`);
	return { shareId: row.id, shareToken, oneTime, expiresAt };
}

/**
 * Resolve a raw share token WITHOUT burning it.
 *
 * Throws {@link FileShareGoneError} when the token is unknown, lapsed,
 * revoked, no longer backed by creator access, or — for a one-time link —
 * already consumed by a different client. A one-time token consumed by *this*
 * client inside the continuation window resolves with `draining: true`: the
 * route then serves byte ranges only, never another full open.
 */
export async function peekFileShare(shareToken: string, fingerprint: string): Promise<FileShareView> {
	const hash = hashToken(shareToken);
	const row = fileShareQueries.getByHash(hash);
	if (!row) {
		throw new FileShareGoneError();
	}

	const now = Date.now();
	if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
		fileShareQueries.deleteByHash(hash);
		throw new FileShareGoneError();
	}

	const oneTime = row.one_time === 1;
	if (oneTime && row.consumed_at) {
		const consumedAt = new Date(row.consumed_at).getTime();
		if (!Number.isFinite(consumedAt) || now - consumedAt > FILE_SHARE_DRAIN_MS) {
			throw new FileShareGoneError();
		}
		if (row.consumer_hash !== fingerprint) {
			throw new FileShareGoneError();
		}
	}

	await assertCreatorStillHasAccess(row.file_path, row.created_by);

	return {
		filePath: row.file_path,
		createdBy: row.created_by,
		oneTime,
		expiresAt: row.expires_at,
		draining: oneTime && row.consumed_at !== null
	};
}

/**
 * Burn the single use of a one-time link on behalf of `fingerprint`.
 *
 * Returns false when the burn was lost — the token was already consumed
 * (by a concurrent first open) or lapsed between the peek and here. The
 * caller re-peeks: the same client continues as a range continuation, a
 * stranger gets the gone response.
 */
export function consumeFileShareLink(shareToken: string, fingerprint: string): boolean {
	const changes = fileShareQueries.consume(hashToken(shareToken), new Date().toISOString(), fingerprint);
	return changes === 1;
}

/** Count an open of a reusable link, so the list can report that it was used. */
export function recordFileShareOpen(shareToken: string): void {
	fileShareQueries.recordOpen(hashToken(shareToken), new Date().toISOString());
}

/**
 * Revoke a share by its row id. The creator or an admin may revoke; returns
 * false when the id is unknown (already used up, lapsed, or revoked).
 *
 * Revoking a link that is inside its continuation window also ends that
 * window, so a stream in progress stops on the next range request.
 */
export function revokeFileShareLink(
	shareId: string,
	role: string | null,
	userId: string | null
): boolean {
	const row = fileShareQueries.getById(shareId);
	if (!row) return false;
	if (role !== 'admin' && row.created_by !== userId) {
		throw new Error('Access denied');
	}
	return fileShareQueries.deleteById(shareId) > 0;
}

/** One entry of the share-management list. Carries no token material. */
export interface FileShareSummary {
	id: string;
	/** Absolute path — the tooltip, and the fallback when nothing owns the file. */
	filePath: string;
	fileName: string;
	projectName: string | null;
	worktreeName: string | null;
	/** Path within the project/worktree, `/`-separated on every platform. */
	relativePath: string;
	createdBy: string;
	createdByName: string | null;
	createdAt: string;
	oneTime: boolean;
	/** ISO deadline, or null for "until revoked". */
	expiresAt: string | null;
	/** How many times the link has been opened — 0 means nobody has yet. */
	openCount: number;
	lastOpenedAt: string | null;
	/** Set once a one-time link has been burned. */
	consumedAt: string | null;
}

/**
 * List live share links: an admin sees every user's, everyone else sees their
 * own. Lapsed rows are filtered by the query, so the list answers "what is
 * reachable right now" rather than "what was ever created".
 */
export function listFileShares(role: string | null, userId: string | null): FileShareSummary[] {
	if (!userId) {
		throw new Error('Access denied');
	}
	const now = new Date().toISOString();
	const rows = role === 'admin'
		? fileShareQueries.listAll(now)
		: fileShareQueries.listForUser(userId, now);

	return rows.map((row) => {
		const location = describeShareLocation(row.file_path);
		return {
			id: row.id,
			filePath: row.file_path,
			fileName: basename(row.file_path),
			projectName: location.projectName,
			worktreeName: location.worktreeName,
			relativePath: location.relativePath,
			createdBy: row.created_by,
			createdByName: row.created_by_name,
			createdAt: row.created_at,
			oneTime: row.one_time === 1,
			expiresAt: row.expires_at,
			openCount: row.open_count,
			lastOpenedAt: row.last_opened_at,
			consumedAt: row.consumed_at
		};
	});
}

/** Drop links that can never serve bytes again (lapsed, or drained out). */
export function sweepStaleFileShares(): number {
	const drainCutoff = new Date(Date.now() - FILE_SHARE_DRAIN_MS).toISOString();
	return fileShareQueries.deleteStale(drainCutoff);
}
