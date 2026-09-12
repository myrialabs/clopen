/**
 * Keeping the tail of a build log.
 *
 * The direction is the whole point: a build log's head is dependency
 * installation, so truncating from the front is the one way to produce an
 * excerpt with no information about the failure in it.
 */

import { describe, it, expect } from 'bun:test';

import { keepTail } from './build-logs';

describe('keepTail', () => {
	it('leaves a log that already fits alone', () => {
		const text = 'one\ntwo\nthree';
		expect(keepTail(text, 1_000)).toEqual({ text, truncated: false });
	});

	it('keeps the END of a log that does not fit', () => {
		const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
		const result = keepTail(text, 120);

		expect(result.truncated).toBe(true);
		expect(result.text).toContain('line 199');
		expect(result.text).not.toContain('line 0\n');
	});

	it('cuts on a line boundary rather than mid-line', () => {
		const text = 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc';
		const result = keepTail(text, 15);

		// Every surviving line is whole — no leading fragment of a dropped one.
		const body = result.text.split('\n').slice(1);
		for (const line of body) {
			expect(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']).toContain(line);
		}
	});

	it('says how much it dropped, so the reader knows the log is partial', () => {
		const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
		expect(keepTail(text, 60).text).toMatch(/^… \d+ earlier lines? omitted …\n/);
	});
});

/**
 * Reading the stage out of the event stream.
 *
 * A build prints nothing for long stretches — uploading, provisioning,
 * assigning domains — and during those the log alone cannot be told apart from
 * a stall. These events are the only thing that speaks, so they are forwarded
 * as a phase rather than dropped with the rest of the non-output events.
 */
import { phaseOf } from './build-logs';

describe('phaseOf', () => {
	it('names the stage from a deployment-state event', () => {
		expect(phaseOf({ type: 'deployment-state', info: { readyState: 'BUILDING' } } as never)).toBe('Building');
		expect(phaseOf({ type: 'deployment-state', info: { readyState: 'UPLOADING' } } as never)).toBe('Uploading');
	});

	it('ignores events that are output rather than state', () => {
		expect(phaseOf({ type: 'stdout', text: 'BUILDING something' })).toBeNull();
		expect(phaseOf({ type: 'command', text: 'npm run build' })).toBeNull();
	});

	it('falls back to the build step when there is no ready state', () => {
		// Still more useful than silence, so it is passed through as written.
		expect(phaseOf({ type: 'deployment-state', info: { step: 'install' } } as never)).toBe('install');
	});

	it('reads the state from a payload-wrapped event too', () => {
		expect(
			phaseOf({ type: 'deployment-state', payload: { info: { readyState: 'READY' } } } as never)
		).toBe('Ready');
	});

	it('answers null when the event names no stage at all', () => {
		expect(phaseOf({ type: 'deployment-state' })).toBeNull();
	});
});
