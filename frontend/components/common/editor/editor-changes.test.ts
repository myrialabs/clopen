/**
 * The change navigator every editor surface shares.
 *
 * What the header promises is tested here: there is a current change from the
 * start ("1/3", never "3 changes"), stepping from a change not yet visited
 * goes to it rather than past it, and clicking or scrolling moves the current
 * change to where the reader is — unless the surface pins it.
 */

import { describe, it, expect } from 'bun:test';
import type { editor } from 'monaco-editor';

import { ChangeNavigator, type ChangeSpan } from './editor-changes';

type Listener<T> = (event: T) => void;

/** The handful of editor calls the navigator makes. */
function fakeEditor() {
	const cursorListeners: Array<Listener<{ source: string; position: { lineNumber: number } }>> = [];
	const scrollListeners: Array<Listener<{ scrollTopChanged: boolean }>> = [];
	const state = { position: 1, visible: { start: 1, end: 20 } };
	const target = {
		onDidChangeCursorPosition: (listener: (typeof cursorListeners)[number]) => {
			cursorListeners.push(listener);
			return { dispose() {} };
		},
		onDidScrollChange: (listener: (typeof scrollListeners)[number]) => {
			scrollListeners.push(listener);
			return { dispose() {} };
		},
		setPosition: ({ lineNumber }: { lineNumber: number }) => {
			state.position = lineNumber;
		},
		revealLineInCenterIfOutsideViewport: () => {},
		getVisibleRanges: () => [{ startLineNumber: state.visible.start, endLineNumber: state.visible.end }]
	};
	return {
		target: target as unknown as editor.ICodeEditor,
		state,
		click: (line: number) => cursorListeners.forEach((l) => l({ source: 'mouse', position: { lineNumber: line } })),
		scrollTo: (start: number, end: number) => {
			state.visible = { start, end };
			scrollListeners.forEach((l) => l({ scrollTopChanged: true }));
		}
	};
}

const spans: ChangeSpan[] = [
	{ type: 'modified', start: 10, end: 12 },
	{ type: 'added', start: 40, end: 41 },
	{ type: 'deleted', start: 90, end: 90 }
];

describe('ChangeNavigator', () => {
	it('has a current change from the start and goes to it first', () => {
		const fake = fakeEditor();
		const revealed: number[] = [];
		const nav = new ChangeNavigator(fake.target, { onUpdate: () => {}, onReveal: (_s, i) => revealed.push(i) });
		nav.setChanges(spans);

		expect(nav.index).toBe(0);
		nav.step(1);
		expect(nav.index).toBe(0);
		expect(fake.state.position).toBe(10);
		nav.step(1);
		expect(nav.index).toBe(1);
		expect(revealed).toEqual([0, 1]);
	});

	it('wraps at either end', () => {
		const fake = fakeEditor();
		const nav = new ChangeNavigator(fake.target, { onUpdate: () => {} });
		nav.setChanges(spans);
		nav.reveal(2);
		nav.step(1);
		expect(nav.index).toBe(0);
		nav.step(-1);
		expect(nav.index).toBe(2);
	});

	it('follows a click into a change and a scroll onto one', () => {
		const fake = fakeEditor();
		const nav = new ChangeNavigator(fake.target, { onUpdate: () => {} });
		nav.setChanges(spans);

		fake.click(41);
		expect(nav.index).toBe(1);

		fake.scrollTo(80, 100);
		expect(nav.index).toBe(2);
	});

	it('holds still while pinned, and clamps when changes go away', () => {
		const fake = fakeEditor();
		let pinned = true;
		const nav = new ChangeNavigator(fake.target, { onUpdate: () => {}, isPinned: () => pinned });
		nav.setChanges(spans);

		fake.scrollTo(80, 100);
		expect(nav.index).toBe(0);
		pinned = false;

		nav.reveal(2);
		nav.setChanges(spans.slice(0, 1));
		expect(nav.index).toBe(0);
		nav.setChanges([]);
		expect(nav.index).toBe(-1);
		expect(nav.count).toBe(0);
	});
});
