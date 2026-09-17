/**
 * Public single-file download route for "Share Link…" links.
 *
 * `GET /api/files/shared?share=<token>` — the counterpart to the
 * authenticated `/api/files/download`. No session is required: the token
 * itself is the credential, and it resolves to exactly one file. The
 * file path is taken from the stored share entry, never from a
 * caller-supplied parameter, so a link cannot be retargeted at another file.
 *
 * A one-time link (the default) is consumed by its first successful open, and
 * any later full open of it (copy-paste, reopen, rescan) answers 410.
 * Byte-range requests (`Range: bytes=…` → 206) keep working briefly after the
 * burn so an already-open video/audio player can buffer, seek and replay — a
 * media player issues many such requests for a single viewing. That
 * continuation window is bound to the client that burned the link (IP + user
 * agent), so a leaked URL cannot be range-read by anyone else inside it.
 *
 * A reusable link skips the burn entirely and serves until its deadline (or
 * until it is revoked), counting each open so the management list can report
 * whether anybody has actually used it.
 *
 * Responses carry `Cache-Control: no-store` so a browser never re-serves the
 * file from its own cache after the link has died server-side.
 *
 * Served `inline` (not `attachment`) with the real `Content-Type` so "Open
 * Link" previews images, PDFs and text directly in the receiving browser —
 * desktop, macOS, Android and iOS alike — while other types still download.
 * `Content-Length` is always set so progress reporting works.
 */

import { Elysia } from 'elysia';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { debug } from '$shared/utils/logger';
import { fileAuditLogQueries } from '../database/queries';
import { findContainingProjectId } from '../ws/files/path-access';
import {
	consumeFileShareLink,
	consumerFingerprint,
	peekFileShare,
	recordFileShareOpen
} from '../files/file-shares';
import { clientIpFromRequest } from '../utils/client-ip';
import { ws } from '../utils/ws';

/** Message shown when a link is opened after its single use (or its TTL). */
export const FILE_SHARE_GONE_MESSAGE = 'This link has already been used or has expired';

/** Extension fallback when Bun cannot sniff a MIME type (keeps video playable). */
const EXTENSION_MIME: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/x-m4v',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	pdf: 'application/pdf'
};

function contentTypeFor(filePath: string, sniffed: string): string {
	if (sniffed) return sniffed;
	// `extname` (not split('.')) so a dotted DIRECTORY on the way down —
	// `C:\build.v2\README`, `/srv/site.old/LICENSE` — is not mistaken for the
	// file's extension on any platform.
	const ext = extname(filePath).slice(1).toLowerCase();
	return EXTENSION_MIME[ext] ?? 'application/octet-stream';
}

interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parse a single `Range: bytes=start-end` header (RFC 9110 §14.2).
 * Returns null for "not a range request" (absent/unparseable/multiple —
 * the caller then serves the full body), or 'unsatisfiable' for a
 * well-formed but out-of-bounds range (caller answers 416).
 */
function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, startStr, endStr] = match;
	if (startStr === '' && endStr === '') return null;

	if (startStr === '') {
		// Suffix range: the last N bytes.
		const suffix = Number(endStr);
		if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'unsatisfiable';
		const start = Math.max(0, size - suffix);
		return { start, end: size - 1 };
	}

	const start = Number(startStr);
	if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'unsatisfiable';
	const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
	if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
	return { start, end };
}

/**
 * Tell every open management view that the list moved.
 *
 * This route is HTTP, not WebSocket, and the person triggering it is not
 * signed in — so the broadcast goes out globally and each client re-reads its
 * own role-scoped list. A "something changed" ping carries nothing to leak.
 */
function notifyShareChanged(): void {
	try {
		ws.emit.global('files:shares-changed', { kind: 'opened' });
	} catch {
		/* a broken socket must never affect the download */
	}
}

/**
 * Standalone HTML page for a link that no longer serves anything.
 *
 * This is the only screen the receiving person ever sees from Clopen, on a
 * device that has never signed in and may never have heard of the app — so it
 * explains what happened and what to do, follows the system colour scheme, and
 * carries its own styles. No asset, font or script is referenced: the response
 * has to render identically on a phone with no network left to fetch them.
 */
function goneResponse(): Response {
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link no longer valid</title>
<style>
	:root { color-scheme: light dark; --bg:#f8fafc; --card:#ffffff; --border:#e2e8f0; --title:#0f172a; --text:#475569; --muted:#94a3b8; --accent:#7c3aed; --accent-bg:#ede9fe; }
	@media (prefers-color-scheme: dark) {
		:root { --bg:#0b1120; --card:#111827; --border:#1f2937; --title:#f1f5f9; --text:#94a3b8; --muted:#64748b; --accent:#a78bfa; --accent-bg:#2e1065; }
	}
	* { box-sizing: border-box; }
	body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
		background:var(--bg); color:var(--text);
		font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }
	.card { width:100%; max-width:26rem; padding:32px 28px; text-align:center;
		background:var(--card); border:1px solid var(--border); border-radius:16px; }
	.badge { width:56px; height:56px; margin:0 auto 20px; display:flex; align-items:center; justify-content:center;
		background:var(--accent-bg); border-radius:50%; }
	.badge svg { width:26px; height:26px; stroke:var(--accent); fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
	h1 { margin:0 0 10px; font-size:1.125rem; line-height:1.4; font-weight:600; color:var(--title); }
	p { margin:0; font-size:0.9375rem; line-height:1.6; }
	.hint { margin-top:18px; padding-top:18px; border-top:1px solid var(--border); font-size:0.8125rem; color:var(--muted); }
</style>
</head>
<body>
	<main class="card">
		<div class="badge" aria-hidden="true">
			<svg viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
		</div>
		<h1>${FILE_SHARE_GONE_MESSAGE}</h1>
		<p>File links open a single file, and most are meant to be used once and then die on their own.</p>
		<p class="hint">Ask whoever sent it to share the file again.</p>
	</main>
</body>
</html>`;
	return new Response(body, {
		status: 410,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
	});
}

export const filesSharedRoute = new Elysia().get('/api/files/shared', async ({ request, query, server }) => {
	const share = typeof query.share === 'string' ? query.share : '';
	if (!share) {
		return new Response('Missing required query parameter: share', { status: 400 });
	}

	const ipAddress = clientIpFromRequest(request, server);
	const userAgent = request.headers.get('user-agent') ?? undefined;
	const fingerprint = consumerFingerprint(ipAddress, userAgent);

	let filePath: string;
	let createdBy: string;
	let oneTime = true;
	// True once a one-time link is burned: only byte-range continuations from
	// the client that burned it are still servable, never a full reopen.
	let consumed = false;
	try {
		// Peek only: the token is consumed below, and only once the file is
		// confirmed servable — a missing file must not burn the single use.
		const entry = await peekFileShare(share, fingerprint);
		filePath = entry.filePath;
		createdBy = entry.createdBy;
		oneTime = entry.oneTime;
		consumed = entry.draining;
	} catch {
		return goneResponse();
	}

	const projectId = await findContainingProjectId(filePath).catch(() => null);

	const logFailure = (message: string, size: number | null = null) => {
		try {
			fileAuditLogQueries.logOperation({
				userId: createdBy,
				projectId,
				action: 'download',
				filePath,
				fileSize: size,
				ipAddress,
				userAgent,
				success: false,
				errorMessage: message
			});
		} catch {
			/* audit logging must never break the response */
		}
	};

	try {
		const stats = await stat(filePath).catch(() => null);
		if (!stats || stats.isDirectory()) {
			logFailure('File not found');
			return new Response('File not found', { status: 404 });
		}

		const file = Bun.file(filePath);
		const name = basename(filePath);
		const contentType = contentTypeFor(filePath, file.type);
		const disposition = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;

		// HEAD reaches this GET handler (the router maps it here), so it is
		// answered explicitly: metadata only, no body, no burn. Without this
		// branch a preflight would be handed the streamed body below and would
		// spend the single use.
		if (request.method === 'HEAD') {
			// No `Content-Length` here: the body is empty, and the runtime
			// derives the header from it — advertising the file's size would
			// not survive the response anyway.
			return new Response(null, {
				headers: {
					'Content-Type': contentType,
					'Content-Disposition': disposition,
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-store'
				}
			});
		}

		// One-time use: burn the token exactly when the file is about to be
		// served. A media player issues many requests for one viewing
		// (initial load, buffering, seek, replay) as byte ranges against the
		// same URL, so ranges are the continuation channel: a range is served
		// on a live token (burning it, like any first open) and keeps being
		// served while draining. A full GET after the burn — copy-paste,
		// reopen, rescan, reload — always fails closed with the gone message.
		const range = parseByteRange(request.headers.get('range'), stats.size);
		if (range === 'unsatisfiable') {
			return new Response('Requested range not satisfiable', {
				status: 416,
				headers: {
					'Content-Range': `bytes */${stats.size}`,
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-store'
				}
			});
		}

		if (oneTime) {
			if (consumed && !range) {
				// A full reopen of a burned link — never the file again.
				return goneResponse();
			}

			if (!consumed && !consumeFileShareLink(share, fingerprint)) {
				// Lost a race with a concurrent first open from this same client
				// (a player firing several requests at once): a range continuation
				// still wins, anything else is gone. A stranger never reaches here
				// — the peek above already rejected a foreign fingerprint.
				const stillServable = range
					? await peekFileShare(share, fingerprint).then((entry) => entry.draining).catch(() => false)
					: false;
				if (!stillServable) {
					logFailure('Share link already used');
					return goneResponse();
				}
				notifyShareChanged();
			} else if (!consumed) {
				notifyShareChanged();
			}
		} else if (!range) {
			// Reusable link: nothing to burn, but a full open still counts — it
			// is the only way the list can say "somebody has opened this". Range
			// requests are excluded so one viewing is not reported as forty.
			recordFileShareOpen(share);
			notifyShareChanged();
		}

		if (range) {
			const length = range.end - range.start + 1;
			return new Response(file.slice(range.start, range.end + 1), {
				status: 206,
				headers: {
					'Content-Type': contentType,
					'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
					'Content-Length': String(length),
					'Content-Disposition': disposition,
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-store'
				}
			});
		}

		try {
			fileAuditLogQueries.logOperation({
				userId: createdBy,
				projectId,
				action: 'download',
				filePath,
				fileSize: stats.size,
				ipAddress,
				userAgent
			});
		} catch {
			/* ignore */
		}

		// Streamed straight from disk, like the authenticated download route.
		// `inline` lets the receiving browser preview (images, PDF, text) on
		// any OS; anything it cannot render still downloads as a file.
		// `Accept-Ranges` is what makes video/audio seekable and replayable;
		// `no-store` is load-bearing for one-time links: without it a browser
		// could re-display the file from its own cache after the link died.
		return new Response(file.stream(), {
			headers: {
				'Content-Type': contentType,
				'Content-Length': String(stats.size),
				'Content-Disposition': disposition,
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'no-store'
			}
		});
	} catch (error) {
		debug.error('file', 'Shared download error:', error);
		const message = error instanceof Error ? error.message : 'Download failed';
		logFailure(message);
		return new Response(message, { status: 500 });
	}
});
