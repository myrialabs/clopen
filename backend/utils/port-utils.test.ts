import { describe, expect, test } from 'bun:test';
import { hasLoopbackCallbackListener } from './port-utils';

const authUrl = (redirect: string) =>
	`https://auth.example.com/authorize?${new URLSearchParams({ client_id: 'x', redirect_uri: redirect })}`;

describe('hasLoopbackCallbackListener', () => {
	test('true while something listens on the loopback redirect port', async () => {
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
		try {
			expect(await hasLoopbackCallbackListener(authUrl(`http://127.0.0.1:${server.port}/auth/callback`))).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test('false when nothing listens there', async () => {
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
		const port = server.port;
		server.stop(true);
		expect(await hasLoopbackCallbackListener(authUrl(`http://127.0.0.1:${port}/auth/callback`))).toBe(false);
	});

	test('false for a hosted redirect or a URL without one', async () => {
		expect(await hasLoopbackCallbackListener(authUrl('https://console.anthropic.com/oauth/code/callback'))).toBe(false);
		expect(await hasLoopbackCallbackListener('https://auth.example.com/authorize')).toBe(false);
		expect(await hasLoopbackCallbackListener('not a url')).toBe(false);
	});
});
