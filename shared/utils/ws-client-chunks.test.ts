/**
 * End to end: a large request-response reply leaves the server in chunks
 * (backend/utils/ws-wire.ts) and the real client reassembles it into exactly
 * the reply it would have received whole.
 */

import { afterEach, expect, test } from 'bun:test';

import { WSClient } from './ws-client';
import { CHUNK_BYTES, sendReply } from '$backend/utils/ws-wire';

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

test('a chunked reply resolves ws.http() with the whole value', async () => {
	const big = { rows: Array.from({ length: 12000 }, (_, i) => ({ id: i, text: `row ${i} — ✓ 😀 "quoted"` })) };
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
		},
		websocket: {
			async message(ws, raw) {
				const { action, payload } = JSON.parse(String(raw));
				if (action !== 'messages:list') return;
				const reply = JSON.stringify({
					action: 'messages:list:response',
					payload: { success: true, data: big, requestId: payload.requestId }
				});
				expect(reply.length).toBeGreaterThan(CHUNK_BYTES);
				await sendReply(ws, 'messages:list:response', payload.requestId, reply);
			}
		}
	});
	servers.push(server);

	const client = new WSClient<{ client: any; server: any }>(`ws://localhost:${server.port}`, { autoReconnect: false });
	await client.waitUntilConnected(5000);

	const data = await client.http('messages:list' as never, {} as never, 10_000);
	expect(data).toEqual(big);
	client.disconnect();
});
