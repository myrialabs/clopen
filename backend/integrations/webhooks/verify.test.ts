import { describe, it, expect } from 'bun:test';
import { createHmac } from 'crypto';
import { verifySignature } from './verify';
import type { WebhookSpec } from '../registry';

const body = new TextEncoder().encode('{"update_id":1}');

describe('header-token', () => {
	const spec: WebhookSpec = { scheme: 'header-token', signatureHeader: 'x-telegram-bot-api-secret-token', secretField: 'webhookSecret' };

	it('accepts the exact secret', () => {
		const headers = new Headers({ 'x-telegram-bot-api-secret-token': 's3cret' });
		expect(verifySignature(spec, 's3cret', body, headers).ok).toBe(true);
	});

	it('rejects another account\'s secret, a missing header and an empty secret', () => {
		expect(verifySignature(spec, 's3cret', body, new Headers({ 'x-telegram-bot-api-secret-token': 'other' })).ok).toBe(false);
		expect(verifySignature(spec, 's3cret', body, new Headers()).ok).toBe(false);
		expect(verifySignature(spec, '', body, new Headers({ 'x-telegram-bot-api-secret-token': '' })).ok).toBe(false);
	});
});

describe('hmac-sha256', () => {
	it('still verifies over the raw bytes', () => {
		const spec: WebhookSpec = { scheme: 'hmac-sha256', signatureHeader: 'x-signature', signaturePrefix: 'sha256=', secretField: 'secret' };
		const digest = createHmac('sha256', 'k').update(body).digest('hex');
		expect(verifySignature(spec, 'k', body, new Headers({ 'x-signature': `sha256=${digest}` })).ok).toBe(true);
		expect(verifySignature(spec, 'k', body, new Headers({ 'x-signature': `sha256=${digest.slice(1)}0` })).ok).toBe(false);
	});
});
