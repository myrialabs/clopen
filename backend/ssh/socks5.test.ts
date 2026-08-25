import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { readSocksRequest, socksReply, SOCKS_REPLY_SUCCESS } from './socks5';

/**
 * A stub standing in for the accepted TCP socket. Only the surface the parser
 * touches is implemented: `on`/`removeListener` for inbound data, `write` and
 * `end` for the replies it sends back, and `unshift` for the bytes it hands to
 * the tunnel. Inbound data is delivered by emitting, not by writing, so the
 * captured outbound writes stay separate from what the test feeds in.
 */
function fakeSocket(): {
	socket: Socket;
	feed: (bytes: number[]) => void;
	close: () => void;
	written: () => Buffer;
	unshifted: () => Buffer;
} {
	const emitter = new EventEmitter();
	const writes: Buffer[] = [];
	const unshifts: Buffer[] = [];

	const stub = emitter as unknown as Socket & {
		unshift: (chunk: Buffer) => void;
		// `writable` is read-only on the real Socket; widened here so the stub can
		// report itself as writable, which the parser checks before replying.
		writable: boolean;
	};
	stub.writable = true;
	stub.write = ((chunk: Buffer) => {
		writes.push(Buffer.from(chunk));
		return true;
	}) as Socket['write'];
	stub.end = ((chunk?: Buffer) => {
		if (chunk) writes.push(Buffer.from(chunk));
		return stub;
	}) as Socket['end'];
	stub.unshift = (chunk: Buffer): void => {
		unshifts.push(Buffer.from(chunk));
	};

	return {
		socket: stub,
		feed: (bytes) => emitter.emit('data', Buffer.from(bytes)),
		close: () => emitter.emit('close'),
		written: () => Buffer.concat(writes),
		unshifted: () => Buffer.concat(unshifts)
	};
}

const NO_AUTH_GREETING = [0x05, 0x01, 0x00];

describe('readSocksRequest', () => {
	test('parses a CONNECT to a domain name', async () => {
		const { socket, feed, written } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		feed([0x05, 0x01, 0x00, 0x03, 0x0b, ...Buffer.from('example.com'), 0x01, 0xbb]);

		await expect(pending).resolves.toEqual({ host: 'example.com', port: 443 });
		// The greeting is answered with "version 5, no authentication".
		expect([...written()]).toEqual([0x05, 0x00]);
	});

	test('parses a CONNECT to an IPv4 address', async () => {
		const { socket, feed } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		feed([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 7, 0x22, 0xb8]);

		await expect(pending).resolves.toEqual({ host: '10.0.0.7', port: 8888 });
	});

	test('parses a CONNECT to an IPv6 address', async () => {
		const { socket, feed } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		feed([
			0x05, 0x01, 0x00, 0x04,
			0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
			0x00, 0x50
		]);

		await expect(pending).resolves.toEqual({ host: '2001:db8:0:0:0:0:0:1', port: 80 });
	});

	test('reassembles a request split across packets', async () => {
		const { socket, feed } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed([0x05]);
		feed([0x01, 0x00]);
		feed([0x05, 0x01, 0x00, 0x03, 0x03]);
		feed([...Buffer.from('abc')]);
		feed([0x00, 0x16]);

		await expect(pending).resolves.toEqual({ host: 'abc', port: 22 });
	});

	test('hands bytes sent after the request back to the socket', async () => {
		const { socket, feed, unshifted } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		feed([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50, 0x47, 0x45, 0x54]);

		await pending;
		expect(unshifted().toString('utf8')).toBe('GET');
	});

	test('rejects a command other than CONNECT', async () => {
		const { socket, feed, written } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		// 0x02 is BIND, which `ssh -D` does not implement either.
		feed([0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]);

		await expect(pending).rejects.toThrow('CONNECT');
		// The greeting reply, then a failure frame with 0x07 = command not supported.
		expect([...written()]).toEqual([0x05, 0x00, 0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
	});

	test('rejects a client that will not do no-auth', async () => {
		const { socket, feed, written } = fakeSocket();
		const pending = readSocksRequest(socket);

		// Offers only username/password (0x02).
		feed([0x05, 0x01, 0x02]);

		await expect(pending).rejects.toThrow('authentication');
		// 0xff = no acceptable methods, sent as the closing frame.
		expect([...written()]).toEqual([0x05, 0xff]);
	});

	test('rejects a non-SOCKS5 client', async () => {
		const { socket, feed } = fakeSocket();
		const pending = readSocksRequest(socket);

		// SOCKS4 announces version 0x04.
		feed([0x04, 0x01]);

		await expect(pending).rejects.toThrow('SOCKS5');
	});

	test('rejects a client that disconnects mid-handshake', async () => {
		const { socket, feed, close } = fakeSocket();
		const pending = readSocksRequest(socket);

		feed(NO_AUTH_GREETING);
		close();

		await expect(pending).rejects.toThrow('disconnected');
	});
});

describe('socksReply', () => {
	test('reports the bound address as 0.0.0.0:0', () => {
		expect([...socksReply(SOCKS_REPLY_SUCCESS)]).toEqual([
			0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0
		]);
	});
});
