/**
 * ssh-client — the SOCKS5 half of dynamic port forwarding.
 *
 * `ssh -D` is a SOCKS5 proxy whose CONNECT requests are opened as channels on
 * the SSH transport. This module speaks just enough of RFC 1928 to serve that:
 * the no-auth handshake and the CONNECT command. BIND and UDP ASSOCIATE are
 * rejected — OpenSSH does not implement them for `-D` either.
 */

import type { Socket } from 'node:net';

const SOCKS_VERSION = 0x05;
const NO_AUTHENTICATION = 0x00;
const NO_ACCEPTABLE_METHODS = 0xff;

const COMMAND_CONNECT = 0x01;

const ADDRESS_IPV4 = 0x01;
const ADDRESS_DOMAIN = 0x03;
const ADDRESS_IPV6 = 0x04;

export const SOCKS_REPLY_SUCCESS = 0x00;
export const SOCKS_REPLY_GENERAL_FAILURE = 0x01;
export const SOCKS_REPLY_HOST_UNREACHABLE = 0x04;
export const SOCKS_REPLY_COMMAND_NOT_SUPPORTED = 0x07;

export interface SocksRequest {
	host: string;
	port: number;
}

/**
 * The reply frame. The bound address is reported as 0.0.0.0:0 — the client is
 * about to be piped into an SSH channel that has no local address of its own,
 * and every SOCKS client tolerates that.
 */
export function socksReply(code: number): Buffer {
	return Buffer.from([SOCKS_VERSION, code, 0x00, ADDRESS_IPV4, 0, 0, 0, 0, 0, 0]);
}

/**
 * Read the greeting and the CONNECT request from `socket`, answering the
 * greeting along the way. Resolves with where the client wants to go; rejects
 * (after sending the matching failure reply) when the exchange is not a
 * no-auth CONNECT.
 *
 * Data arriving after the request is left unread on the socket, so the caller
 * can pipe it straight into the SSH channel without losing a byte.
 */
export function readSocksRequest(socket: Socket): Promise<SocksRequest> {
	return new Promise((resolvePromise, rejectPromise) => {
		let buffered = Buffer.alloc(0);
		let greeted = false;
		let settled = false;

		const cleanup = (): void => {
			socket.removeListener('data', onData);
			socket.removeListener('error', onError);
			socket.removeListener('close', onClose);
		};

		const fail = (message: string, replyCode: number): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (replyCode !== SOCKS_REPLY_SUCCESS && socket.writable) {
				socket.write(socksReply(replyCode));
			}
			rejectPromise(new Error(message));
		};

		const succeed = (request: SocksRequest, consumed: number): void => {
			if (settled) return;
			settled = true;
			cleanup();
			// Anything the client sent past the request belongs to the tunnel.
			const leftover = buffered.subarray(consumed);
			if (leftover.length > 0) socket.unshift(leftover);
			resolvePromise(request);
		};

		function onData(chunk: Buffer): void {
			buffered = Buffer.concat([buffered, chunk]);

			if (!greeted) {
				if (buffered.length < 2) return;
				if (buffered[0] !== SOCKS_VERSION) {
					fail('Not a SOCKS5 client', SOCKS_REPLY_GENERAL_FAILURE);
					return;
				}
				const methodCount = buffered[1];
				const greetingLength = 2 + methodCount;
				if (buffered.length < greetingLength) return;

				const methods = buffered.subarray(2, greetingLength);
				if (!methods.includes(NO_AUTHENTICATION)) {
					settled = true;
					cleanup();
					socket.end(Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_METHODS]));
					rejectPromise(new Error('SOCKS client requires authentication'));
					return;
				}

				socket.write(Buffer.from([SOCKS_VERSION, NO_AUTHENTICATION]));
				buffered = buffered.subarray(greetingLength);
				greeted = true;
			}

			if (buffered.length < 4) return;
			if (buffered[0] !== SOCKS_VERSION) {
				fail('Malformed SOCKS5 request', SOCKS_REPLY_GENERAL_FAILURE);
				return;
			}
			if (buffered[1] !== COMMAND_CONNECT) {
				fail('Only the CONNECT command is supported', SOCKS_REPLY_COMMAND_NOT_SUPPORTED);
				return;
			}

			const addressType = buffered[3];
			let host: string;
			let cursor: number;

			if (addressType === ADDRESS_IPV4) {
				if (buffered.length < 10) return;
				host = Array.from(buffered.subarray(4, 8)).join('.');
				cursor = 8;
			} else if (addressType === ADDRESS_DOMAIN) {
				const nameLength = buffered[4];
				if (buffered.length < 5 + nameLength + 2) return;
				host = buffered.subarray(5, 5 + nameLength).toString('utf8');
				cursor = 5 + nameLength;
			} else if (addressType === ADDRESS_IPV6) {
				if (buffered.length < 22) return;
				const groups: string[] = [];
				for (let offset = 4; offset < 20; offset += 2) {
					groups.push(buffered.readUInt16BE(offset).toString(16));
				}
				host = groups.join(':');
				cursor = 20;
			} else {
				fail('Unsupported SOCKS5 address type', SOCKS_REPLY_HOST_UNREACHABLE);
				return;
			}

			const port = buffered.readUInt16BE(cursor);
			succeed({ host, port }, cursor + 2);
		}

		function onError(error: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(error);
		}

		function onClose(): void {
			fail('SOCKS client disconnected during the handshake', SOCKS_REPLY_SUCCESS);
		}

		socket.on('data', onData);
		socket.on('error', onError);
		socket.on('close', onClose);
	});
}
