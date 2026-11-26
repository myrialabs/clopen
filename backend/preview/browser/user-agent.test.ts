import { describe, expect, test } from 'bun:test';
import { toHeadfulUserAgent } from './user-agent';

describe('toHeadfulUserAgent', () => {
	test('drops only the headless marker, keeping the platform and version Chrome reported', () => {
		expect(
			toHeadfulUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36'
			)
		).toBe(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36'
		);
		expect(
			toHeadfulUserAgent(
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36'
			)
		).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
	});

	test('leaves a headful User-Agent as it is', () => {
		const ua =
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
		expect(toHeadfulUserAgent(ua)).toBe(ua);
	});
});
