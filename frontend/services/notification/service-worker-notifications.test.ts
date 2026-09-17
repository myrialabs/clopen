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

	// iPadOS 13+ Safari requests desktop sites by default and sends the macOS
	// UA verbatim. Matching on the UA alone routes every modern iPad to the
	// desktop path, where iOS/iPadOS has no `Notification` constructor at all
	// and the notification is silently lost. Touch points are the only signal
	// that separates the two devices.
	test('matches iPadOS Safari sending the desktop macOS user agent', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
				5
			)
		).toBe(true);
	});

	test('still does not match a Mac, which reports zero touch points', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
				0
			)
		).toBe(false);
	});

	test('does not promote a Windows touchscreen laptop to the mobile path', () => {
		expect(
			isMobileUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				10
			)
		).toBe(false);
	});

	test('matches Firefox on Android', () => {
		expect(
			isMobileUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0')
		).toBe(true);
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
