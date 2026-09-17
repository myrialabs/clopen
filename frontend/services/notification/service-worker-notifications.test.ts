import { describe, expect, test } from 'bun:test';

import { isMobileUserAgent } from './service-worker-notifications';

describe('isMobileUserAgent', () => {
	test('matches Android Chrome', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
			)
		).toBe(true);
	});

	test('matches iPhone Safari', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
			)
		).toBe(true);
	});

	test('matches iPad Safari', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
			)
		).toBe(true);
	});

	test('does not match Windows desktop Chrome (even touchscreen laptops)', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			)
		).toBe(false);
	});

	test('does not match macOS desktop Safari', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
			)
		).toBe(false);
	});

	test('does not match Linux desktop Chrome', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			)
		).toBe(false);
	});

	test('does not match an empty UA', () => {
		expect(isMobileUserAgent('')).toBe(false);
	});
});
