import { describe, expect, test } from 'bun:test';
import { findLaunchSlot, resolveLandedUrl } from './preview-launch';

describe('finding the slot a reported tab belongs to', () => {
	test('matches the launch by name even after Stop cleared the flag', () => {
		// The regression this exists for: Stop sets isLaunchingBrowser false,
		// the backend finishes anyway, and the tab it reports has to come home
		// to this slot instead of being opened as a second one.
		const slots = [
			{ id: 'a', launchId: null, isLaunchingBrowser: false, sessionId: 'tab-1' },
			{ id: 'b', launchId: 'launch-9', isLaunchingBrowser: false, sessionId: null }
		];

		expect(findLaunchSlot(slots, 'launch-9')?.id).toBe('b');
	});

	test('never hands a tab to a slot waiting on a different launch', () => {
		const slots = [
			{ id: 'a', launchId: 'launch-1', isLaunchingBrowser: true, sessionId: null },
			{ id: 'b', launchId: 'launch-2', isLaunchingBrowser: true, sessionId: null }
		];

		expect(findLaunchSlot(slots, 'launch-2')?.id).toBe('b');
	});

	test('falls back to the launching slot when the tab carries no launch', () => {
		// An agent-opened tab names no launch; a slot mid-launch still claims it
		// rather than letting a duplicate through.
		const slots = [
			{ id: 'a', launchId: null, isLaunchingBrowser: false, sessionId: 'tab-1' },
			{ id: 'b', launchId: null, isLaunchingBrowser: true, sessionId: null }
		];

		expect(findLaunchSlot(slots, undefined)?.id).toBe('b');
	});

	test('claims nothing when no slot is waiting', () => {
		const slots = [{ id: 'a', launchId: null, isLaunchingBrowser: false, sessionId: 'tab-1' }];

		expect(findLaunchSlot(slots, 'launch-9')).toBeUndefined();
		expect(findLaunchSlot(slots, undefined)).toBeUndefined();
	});
});

describe('the address a reported tab should show', () => {
	test('keeps what the user asked for when the load never committed', () => {
		expect(resolveLandedUrl('about:blank', 'https://example.com')).toBe('https://example.com');
	});

	test('prefers where the page actually landed', () => {
		expect(resolveLandedUrl('https://example.com/login', 'https://example.com')).toBe(
			'https://example.com/login'
		);
	});

	test('copes with a backend that reported nothing', () => {
		expect(resolveLandedUrl(undefined, 'https://example.com')).toBe('https://example.com');
		expect(resolveLandedUrl(null, '')).toBe('');
	});
});
