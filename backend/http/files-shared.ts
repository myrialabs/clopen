/**
 * Public single-file download route for "Share via Link / QR Code" links.
 *
 * `GET /api/files/shared?share=<token>` — the counterpart to the
 * authenticated `/api/files/download`. No session is required: the token
 * itself is the credential, and it resolves to exactly one file. The
 * file path is taken from the stored share entry, never from a
 * caller-supplied parameter, so a link cannot be retargeted at another file.
 *
 * Links are ONE-TIME: the first successful open consumes the token, and any
 * later full open of the same link (copy-paste, reopen, rescan) answers 410
 * with "Link sudah digunakan atau sudah kedaluwarsa". Byte-range requests
 * (`Range: bytes=…` → 206) keep working briefly after the burn so an
 * already-open video/audio player can buffer, seek and replay — a media
 * player issues many such requests for a single viewing. Responses carry
 * `Cache-Control: no-store` so a browser never re-serves the file from its
 * own cache after the link has died server-side.
 *
 * Served `inline` (not `attachment`) with the real `Content-Type` so "Open
 * Link" previews images, PDFs and text directly in the receiving browser —
 * desktop, macOS, Android and iOS alike — while other types still download.
 * `Content-Length` is always set so progress reporting works.
 */

import { Elysia } from 'elysia';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { debug } from '$shared/utils/logger';
import { fileAuditLogQueries } from '../database/queries';
import { findContainingProjectId } from '../ws/files/path-access';
import { consumeFileShareLink, getDrainingShare, resolveFileShareLink } from '../files/file-shares';
import { clientIpFromRequest } from '../utils/client-ip';

/** Message shown when a link is opened after its single use (or its TTL). */
export const FILE_SHARE_GONE_MESSAGE = 'Link sudah digunakan atau sudah kedaluwarsa';

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
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
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
 * Plain HTML page carrying the gone message, so "Open Link" in any browser
 * renders it as a readable notice instead of a bare status line.
 */
function goneResponse(): Response {
	const body =
		'<!doctype html><html lang="id"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1">' +
		'<title>Tautan tidak berlaku</title></head>' +
		'<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;background:#f8fafc;color:#334155">' +
		`<p style="font-size:16px;text-align:center">${FILE_SHARE_GONE_MESSAGE}</p></body></html>`;
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

	let filePath: string;
	let createdBy: string | null;
	// True once the single use is burned: only byte-range continuations from
	// the already-open player are still servable, never a full reopen.
	let consumed = false;
	try {
		// Peek only: the token is consumed below, and only once the file is
		// confirmed servable — a missing file must not burn the single use.
		const entry = resolveFileShareLink(share);
		filePath = entry.filePath;
		createdBy = entry.createdBy;
	} catch {
		const drained = getDrainingShare(share);
		if (!drained) return goneResponse();
		filePath = drained.filePath;
		createdBy = drained.createdBy;
		consumed = true;
	}

	const ipAddress = clientIpFromRequest(request, server);
	const userAgent = request.headers.get('user-agent') ?? undefined;
	const projectId = await findContainingProjectId(filePath).catch(() => null);

	const logFailure = (message: string, size: number | null = null) => {
		try {
			fileAuditLogQueries.logOperation({
				userId: createdBy ?? 'unknown',
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
		if (!stats) {
			logFailure('File not found');
			return new Response('File not found', { status: 404 });
		}
		if (stats.isDirectory()) {
			logFailure('Not a file');
			return goneResponse();
		}

		// One-time use: burn the token exactly when the file is about to be
		// served. A media player issues many requests for one viewing
		// (initial load, buffering, seek, replay) as byte ranges against the
		// same URL, so ranges are the continuation channel: a range is served
		// on a live token (burning it, like any first open) and keeps being
		// served while draining. A full GET after the burn — copy-paste,
		// reopen, rescan, reload — always fails closed with the gone message.
		// Non-GET (e.g. HEAD preflights) only peek so they can never burn it.
		const isGet = request.method === 'GET';
		const range = isGet ? parseByteRange(request.headers.get('range'), stats.size) : null;
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

		const file = Bun.file(filePath);
		const name = basename(filePath);
		const contentType = contentTypeFor(filePath, file.type);
		const disposition = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;

		if (range) {
			if (!consumed) {
				try {
					consumeFileShareLink(share);
				} catch {
					// Lost a race with a concurrent first open: re-check the
					// drain — a range continuation still wins, a stranger 410s.
					const drained = getDrainingShare(share);
					if (!drained) {
						logFailure('Share link already used');
						return goneResponse();
					}
				}
			}
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

		if (consumed) {
			// A full reopen of a burned link — never the file again.
			return goneResponse();
		}

		if (isGet) {
			try {
				consumeFileShareLink(share);
			} catch {
				logFailure('Share link already used');
				return goneResponse();
			}
		}

		try {
			fileAuditLogQueries.logOperation({
				userId: createdBy ?? 'unknown',
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
