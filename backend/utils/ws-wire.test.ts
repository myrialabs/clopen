/**
 * The send path every frame takes: what gets compressed, and how a large
 * reply leaves in chunks without filling the socket's buffer.
 */

import { describe, expect, test } from 'bun:test';

import { decodeChunk } from '$shared/utils/ws-chunk';
import { CHUNK_BYTES, COMPRESS_MIN_BYTES, sendBinary, sendReply, sendText } from './ws-wire';

class FakeSocket {
	readyState = 1;
	buffered = 0;
	sent: Array<{ data: string | Buffer; compress?: boolean }> = [];
	raw = { getBufferedAmount: () => this.buffered };
	send(data: string | Buffer, compress?: boolean) {
		this.sent.push({ data, compress });
	}
}

describe('sendText / sendBinary', () => {
	test('compresses text only when it is large enough to gain from it', () => {
		const socket = new FakeSocket();
		sendText(socket, 'small', 'x'.repeat(COMPRESS_MIN_BYTES - 1));
		sendText(socket, 'large', 'x'.repeat(COMPRESS_MIN_BYTES));
		expect(socket.sent.map((frame) => frame.compress)).toEqual([false, true]);
	});

	test('never compresses binary', () => {
		const socket = new FakeSocket();
		sendBinary(socket, 'file:download', new Uint8Array(100_000));
		expect(socket.sent[0].compress).toBe(false);
		expect(Buffer.isBuffer(socket.sent[0].data)).toBe(true);
	});
});

describe('sendReply', () => {
	test('sends a reply under the threshold as one ordinary frame', async () => {
		const socket = new FakeSocket();
		const text = JSON.stringify({ action: 'x:response', payload: { ok: true } });
		await sendReply(socket, 'x:response', 'req-1', text);
		expect(socket.sent).toEqual([{ data: text, compress: false }]);
	});

	test('chunks a large reply into pieces that reassemble to the exact text', async () => {
		const socket = new FakeSocket();
		const text = JSON.stringify({ action: 'messages:list:response', payload: { data: 'é😀'.repeat(CHUNK_BYTES) } });
		await sendReply(socket, 'messages:list:response', 'req-2', text);

		const chunks = socket.sent.map((frame) => decodeChunk(frame.data as string)!);
		expect(chunks.length).toBeGreaterThan(1);
		expect(new Set(chunks.map((chunk) => chunk.streamId)).size).toBe(1);
		expect(chunks.every((chunk) => chunk.requestId === 'req-2' && chunk.count === chunks.length)).toBe(true);
		expect(chunks.map((chunk) => chunk.slice).join('')).toBe(text);
	});

	test('two replies get distinct streams', async () => {
		const socket = new FakeSocket();
		const text = 'x'.repeat(CHUNK_BYTES * 2);
		await sendReply(socket, 'a', 'req', text);
		await sendReply(socket, 'a', 'req', text);
		const streams = new Set(socket.sent.map((frame) => decodeChunk(frame.data as string)!.streamId));
		expect(streams.size).toBe(2);
	});

	test('waits for the socket to drain between chunks', async () => {
		const socket = new FakeSocket();
		socket.buffered = 10 * 1024 * 1024;
		const sending = sendReply(socket, 'a', 'req', 'x'.repeat(CHUNK_BYTES * 3));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(socket.sent).toHaveLength(1); // first chunk only, then held

		socket.buffered = 0;
		await sending;
		expect(socket.sent).toHaveLength(3);
	});

	test('stops when the socket closes mid-reply', async () => {
		const socket = new FakeSocket();
		socket.buffered = 10 * 1024 * 1024;
		const sending = sendReply(socket, 'a', 'req', 'x'.repeat(CHUNK_BYTES * 3));
		await new Promise((resolve) => setTimeout(resolve, 20));
		socket.readyState = 3;
		await sending;
		expect(socket.sent).toHaveLength(1);
	});
});
