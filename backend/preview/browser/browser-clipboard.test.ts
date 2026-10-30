/**
 * The workspace clipboard's one job besides holding text: telling the user's
 * devices about copies they did not make, and never echoing theirs back.
 */

import { describe, expect, test } from 'bun:test';
import { WorkspaceClipboard, type ClipboardChange } from './browser-clipboard';

function watch(clipboard: WorkspaceClipboard): ClipboardChange[] {
	const changes: ClipboardChange[] = [];
	clipboard.on('changed', (change: ClipboardChange) => changes.push(change));
	return changes;
}

describe('WorkspaceClipboard', () => {
	test('a page copy is held and announced to the devices', () => {
		const clipboard = new WorkspaceClipboard();
		const changes = watch(clipboard);

		clipboard.write('TOKEN', 'page');

		expect(clipboard.read()).toBe('TOKEN');
		expect(changes.map((change) => [change.text, change.source])).toEqual([['TOKEN', 'page']]);
	});

	test('a copy from the device is held but not sent back to it', () => {
		const clipboard = new WorkspaceClipboard();
		const changes = watch(clipboard);

		clipboard.write('from my laptop', 'device');

		expect(clipboard.read()).toBe('from my laptop');
		expect(changes).toEqual([]);
	});

	test('writing the same text again announces nothing', () => {
		const clipboard = new WorkspaceClipboard();
		const changes = watch(clipboard);

		clipboard.write('same', 'agent');
		clipboard.write('same', 'page');

		expect(changes).toHaveLength(1);
		expect(clipboard.describe().source).toBe('page');
	});
});
