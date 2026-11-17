/**
 * The last step before a frame leaves the server — the one place that decides
 * how it travels.
 *
 * Every event (`backend/utils/ws.ts`) and every request-response reply
 * (`shared/utils/ws-server.ts`) is sent through here, so three concerns live
 * once instead of at every call site:
 *
 * 1. Compression. The socket negotiates permessage-deflate (see
 *    `WS_PER_MESSAGE_DEFLATE`), but Bun only compresses a frame when asked to.
 *    JSON shrinks 4–12× under deflate; a frame under ~1 KB grows instead, and
 *    binary frames (uploads, downloads, media) are already dense — so only text
 *    of at least `COMPRESS_MIN_BYTES` is compressed.
 *
 * 2. Large replies are chunked. A request-response reply above `CHUNK_BYTES`
 *    used to leave as one frame. The browser only reports a frame once all of it
 *    has arrived, so on a slow link a multi-megabyte reply looked like silence:
 *    the client's 30 s request timer fired mid-download and re-sent the read —
 *    queueing a second copy — or tore the socket down and started over. Chunks
 *    are proof of progress (each one re-arms the request's timer), they let
 *    events slip in between instead of waiting behind the whole reply, and
 *    sending waits for the socket to drain so a slow client never makes the
 *    server buffer an entire reply in memory. Events are never chunked: they
 *    must arrive in the order they were emitted.
 *
 * 3. A traffic meter (development, or `CLOPEN_WS_TRAFFIC=1`) that adds up bytes
 *    per action, so a bandwidth claim can be checked against real traffic
 *    instead of an estimate.
 */

import type { WebSocketCompressor } from 'bun';
import { debug } from '$shared/utils/logger';
import { SERVER_ENV } from './env';
import { encodeChunk, sliceText } from '$shared/utils/ws-chunk';

/** Text frames shorter than this are sent uncompressed — deflate would grow them. */
export const COMPRESS_MIN_BYTES = 1024;

/** Request-response replies longer than this (in characters) are chunked. */
export const CHUNK_BYTES = 256 * 1024;

/** Stop sending chunks while the socket has more than this queued. */
const DRAIN_HIGH_WATER = 1024 * 1024;

/** How often to re-check a full socket. */
const DRAIN_POLL_MS = 10;

/**
 * Compression the server offers. A per-socket compressor keeps context across
 * messages, which is what makes the stream of small, similar JSON events
 * (stream deltas, file changes, terminal output) compress well; 32 KB per
 * connection is the price. Client → server frames are small and use the shared
 * decompressor.
 */
export const WS_PER_MESSAGE_DEFLATE: { compress: WebSocketCompressor; decompress: WebSocketCompressor } = {
	compress: '32KB',
	decompress: 'shared'
};

/**
 * Server-wide socket options, handed to `new Elysia({ websocket })`.
 *
 * They must be set there. Elysia drops the same keys on a `.ws()` route, which
 * is where they used to live — so for as long as that was the case Bun's
 * defaults applied instead: a 16 MB frame limit that closed the socket on any
 * larger upload (1006), and a 120 s idle timeout.
 */
export const WS_SERVER_OPTIONS = {
	// Allow large binary frames (file uploads, zip extracts); the per-file
	// limits are enforced by the handlers, not by the transport.
	maxPayloadLength: 1024 * 1024 * 1024, // 1 GiB
	// Don't drop a connection that is busy with one long binary transfer.
	idleTimeout: 960, // seconds (max allowed by uWS)
	perMessageDeflate: WS_PER_MESSAGE_DEFLATE
};

/** Numbers each chunked reply, so two replies to one re-sent request stay apart. */
let replyStreams = 0;

/** The part of a socket this module needs: Elysia's wrapper or Bun's own. */
interface WireSocket {
	readyState: number;
	send(data: string | Buffer, compress?: boolean): unknown;
	raw?: { getBufferedAmount?: () => number };
	getBufferedAmount?: () => number;
}

/** Send one text frame, compressed when it is big enough to gain from it. */
export function sendText(conn: WireSocket, action: string, text: string): void {
	conn.send(text, text.length >= COMPRESS_MIN_BYTES);
	recordTraffic(action, text.length);
}

/** Send one binary frame. Never compressed: it is already dense. */
export function sendBinary(conn: WireSocket, action: string, data: ArrayBuffer | Uint8Array | Buffer): void {
	const buffer = Buffer.isBuffer(data)
		? data
		: data instanceof ArrayBuffer
			? Buffer.from(data)
			: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	conn.send(buffer, false);
	recordTraffic(action, buffer.byteLength);
}

/**
 * Send a serialized request-response reply, chunked when it is large.
 * Resolves once the last chunk is handed to the socket (or the socket closed).
 */
export async function sendReply(conn: WireSocket, action: string, requestId: string, text: string): Promise<void> {
	if (text.length <= CHUNK_BYTES || !requestId) {
		sendText(conn, action, text);
		return;
	}

	const slices = sliceText(text, CHUNK_BYTES);
	const streamId = String(++replyStreams);
	for (let index = 0; index < slices.length; index++) {
		if (index > 0) {
			await waitForDrain(conn);
			if (conn.readyState !== 1) return; // The client is gone; it will re-request.
		}
		const frame = encodeChunk(streamId, requestId, index, slices.length, slices[index]);
		conn.send(frame, true);
		recordTraffic(action, frame.length);
	}
}

function bufferedAmount(conn: WireSocket): number {
	try {
		if (typeof conn.raw?.getBufferedAmount === 'function') return conn.raw.getBufferedAmount();
		if (typeof conn.getBufferedAmount === 'function') return conn.getBufferedAmount();
	} catch {
		// A closed socket throws; the caller checks readyState next.
	}
	return 0;
}

async function waitForDrain(conn: WireSocket): Promise<void> {
	while (conn.readyState === 1 && bufferedAmount(conn) > DRAIN_HIGH_WATER) {
		await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
	}
}

// ============================================================================
// Traffic meter
// ============================================================================

const TRAFFIC_ENABLED = SERVER_ENV.isDevelopment || process.env.CLOPEN_WS_TRAFFIC === '1';
const TRAFFIC_REPORT_MS = 30_000;

const traffic = new Map<string, { frames: number; bytes: number }>();
let reportTimer: ReturnType<typeof setInterval> | null = null;

function recordTraffic(action: string, bytes: number): void {
	if (!TRAFFIC_ENABLED) return;
	const entry = traffic.get(action);
	if (entry) {
		entry.frames++;
		entry.bytes += bytes;
	} else {
		traffic.set(action, { frames: 1, bytes });
	}
	if (!reportTimer) {
		reportTimer = setInterval(reportTraffic, TRAFFIC_REPORT_MS);
		reportTimer.unref?.();
	}
}

/** Bytes sent per action since the last report (before compression), largest first. */
export function takeTrafficReport(): Array<{ action: string; frames: number; bytes: number }> {
	const rows = [...traffic.entries()]
		.map(([action, entry]) => ({ action, ...entry }))
		.sort((a, b) => b.bytes - a.bytes);
	traffic.clear();
	return rows;
}

function reportTraffic(): void {
	const rows = takeTrafficReport();
	if (rows.length === 0) return;
	const total = rows.reduce((sum, row) => sum + row.bytes, 0);
	const lines = rows
		.slice(0, 15)
		.map((row) => `  ${(row.bytes / 1024).toFixed(1).padStart(10)} KB  ${String(row.frames).padStart(6)}×  ${row.action}`);
	debug.log(
		'websocket',
		`WS traffic, last ${TRAFFIC_REPORT_MS / 1000}s: ${(total / 1024).toFixed(1)} KB before compression\n${lines.join('\n')}`
	);
}
