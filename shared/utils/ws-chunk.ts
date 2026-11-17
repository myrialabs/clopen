/**
 * Wire format of a chunked request-response reply — shared by the server that
 * cuts it (backend/utils/ws-wire.ts) and the client that reassembles it
 * (shared/utils/ws-client.ts), so the two cannot drift.
 *
 * `\u0001<streamId>\u0002<requestId>\u0002<index>\u0002<count>\u0002<text slice>`
 *
 * `streamId` is unique per reply. A read that was re-sent can be answered
 * twice under one requestId, and the two replies must not be stitched into
 * each other; the second one to complete is ignored like any duplicate reply.
 *
 * JSON frames always start with `{`, so a leading control character cannot be
 * mistaken for one, and the slice is raw text — not re-escaped inside another
 * JSON string, which would grow every quote and backslash.
 */

export const CHUNK_MARKER = '\u0001';
export const CHUNK_MARKER_CODE = 1;
export const CHUNK_SEPARATOR = '\u0002';

export interface Chunk {
	streamId: string;
	requestId: string;
	index: number;
	count: number;
	slice: string;
}

export function encodeChunk(streamId: string, requestId: string, index: number, count: number, slice: string): string {
	return [CHUNK_MARKER + streamId, requestId, index, count, slice].join(CHUNK_SEPARATOR);
}

export function decodeChunk(frame: string): Chunk | null {
	if (frame.charCodeAt(0) !== CHUNK_MARKER_CODE) return null;
	const cuts: number[] = [];
	let from = 0;
	for (let i = 0; i < 4; i++) {
		const at = frame.indexOf(CHUNK_SEPARATOR, from);
		if (at < 0) return null;
		cuts.push(at);
		from = at + 1;
	}
	const index = Number(frame.slice(cuts[1] + 1, cuts[2]));
	const count = Number(frame.slice(cuts[2] + 1, cuts[3]));
	if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return null;
	return {
		streamId: frame.slice(1, cuts[0]),
		requestId: frame.slice(cuts[0] + 1, cuts[1]),
		index,
		count,
		slice: frame.slice(cuts[3] + 1)
	};
}

/**
 * Cut text into pieces of at most `size` UTF-16 units without splitting a
 * surrogate pair — half of one would be replaced on the wire and corrupt the
 * reassembled JSON.
 */
export function sliceText(text: string, size: number): string[] {
	const slices: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		if (end < text.length) {
			const code = text.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) end--;
		}
		slices.push(text.slice(start, end));
		start = end;
	}
	return slices;
}
