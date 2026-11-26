import { describe, expect, test } from 'bun:test';
import { hostSlug, screenshotContext, screenshotFileName, timestampSlug, type ScreenshotMeta } from './screenshot-naming';

const capturedAt = new Date(2026, 10, 26, 14, 30, 5).getTime();

const meta: ScreenshotMeta = {
	url: 'http://localhost:5173/pricing',
	title: 'Pricing',
	deviceSize: 'laptop',
	deviceModel: 'macbook-air-13',
	viewport: { width: 1440, height: 900 },
	mode: 'viewport',
	capturedAt
};

describe('screenshot file names', () => {
	test('host and local time, so they sort and say where they came from', () => {
		expect(timestampSlug(capturedAt)).toBe('20261126-143005');
		expect(screenshotFileName(meta, 'png')).toBe('localhost-5173-20261126-143005.png');
	});

	test('say what was captured when it was not the visible page', () => {
		expect(screenshotFileName({ ...meta, mode: 'fullPage' }, 'jpg')).toBe('localhost-5173-20261126-143005-full.jpg');
		expect(screenshotFileName({ ...meta, mode: 'element' }, 'png')).toBe('localhost-5173-20261126-143005-element.png');
		expect(screenshotFileName({ ...meta, mode: 'region' }, 'png')).toBe('localhost-5173-20261126-143005-area.png');
		expect(screenshotFileName({ ...meta, mode: 'device', deviceSize: 'mobile' }, 'png')).toBe(
			'localhost-5173-20261126-143005-mobile.png'
		);
	});

	test('pages without a host still get a name', () => {
		expect(hostSlug('about:blank')).toBe('page');
		expect(hostSlug('file:///tmp/index.html')).toBe('file');
		expect(hostSlug('not a url')).toBe('page');
	});
});

describe('screenshotContext', () => {
	test('names the page and the size it was laid out at', () => {
		expect(screenshotContext([meta])).toBe(
			'Screenshot of Pricing — http://localhost:5173/pricing: the visible page on laptop (macbook-air-13, 1440×900 viewport).'
		);
	});

	test('lists every device of a responsive set', () => {
		const context = screenshotContext([
			{ ...meta, mode: 'device', deviceSize: 'mobile', deviceModel: null, viewport: { width: 402, height: 874 } },
			{ ...meta, mode: 'device' }
		]);
		expect(context).toBe(
			'Screenshots of Pricing — http://localhost:5173/pricing:\n' +
				'1. the visible page on mobile (402×874 viewport)\n' +
				'2. the visible page on laptop (macbook-air-13, 1440×900 viewport)'
		);
	});

	test('a page whose title is its address is not named twice', () => {
		expect(screenshotContext([{ ...meta, title: meta.url, mode: 'region' }])).toBe(
			'Screenshot of http://localhost:5173/pricing: a selected area on laptop (macbook-air-13, 1440×900 viewport).'
		);
	});
});
