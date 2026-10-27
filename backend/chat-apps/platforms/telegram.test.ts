/**
 * A webhook delivery must get past ChatKit's own check, not only the
 * gateway's: an adapter built without the secret rejects every delivery.
 */

import { describe, it, expect } from 'bun:test';
import { telegramPlatform } from './telegram';

const request = (secret?: string) => {
	const headers: Record<string, string> = secret ? { 'x-telegram-bot-api-secret-token': secret } : {};
	return { method: 'POST', headers, body: '{}' };
};

describe('the Telegram webhook adapter', () => {
	it('accepts a delivery carrying the bot’s secret, and only that one', () => {
		const adapter = telegramPlatform.createAdapter({ account: 'a', credentials: { botToken: '1:x', webhookSecret: 's3cret' }, mode: 'webhook' });
		expect(adapter.verifyInbound?.(request('s3cret'))).toBe(true);
		expect(adapter.verifyInbound?.(request('other'))).toBe(false);
		expect(adapter.verifyInbound?.(request())).toBe(false);
	});
});

describe('what Telegram calls a command', () => {
	const parse = (text: string) => telegramPlatform.parseCommand(text);

	it('reads /name and /name@bot with their argument', () => {
		expect(parse('/run review_pr 123')).toEqual({ command: 'run', argument: 'review_pr 123' });
		expect(parse('/Model@clopen_bot claude')).toEqual({ command: 'model', argument: 'claude' });
		expect(parse('/status')).toEqual({ command: 'status', argument: '' });
	});

	it('leaves a skill’s own /slug, a path and a URL path as plain text, so none can shadow a command', () => {
		for (const text of ['/new-feature add login', '/review-pr 12', '/usr/bin/env', '/api/v1/users', 'not a /command']) expect(parse(text)).toBeNull();
	});
});
