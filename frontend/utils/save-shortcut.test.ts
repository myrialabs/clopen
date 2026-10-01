/**
 * Save shortcut routing.
 *
 * The two failures this replaced: a viewer inside a dialog never saw the chord
 * (the dialog stopped keydown before it reached `window`), and two viewers on
 * screen both saved on one keystroke. Both come down to which surface a single
 * Ctrl/Cmd+S is delivered to, so that is what is tested here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { saveShortcut } from './save-shortcut';

/** Just enough of a DOM node: a parent chain, containment and listeners. */
class FakeNode {
	parent: FakeNode | null = null;
	isConnected = true;
	attributes = new Map<string, string>();
	listeners = new Map<string, Array<() => void>>();

	constructor(parent: FakeNode | null = null) {
		this.parent = parent;
	}

	contains(other: FakeNode | null): boolean {
		for (let node = other; node; node = node.parent) if (node === this) return true;
		return false;
	}

	addEventListener(type: string, listener: () => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	removeEventListener(type: string, listener: () => void) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
	}

	fire(type: string) {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

type KeyListener = (event: FakeKeyEvent) => void;

interface FakeKeyEvent {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	target: FakeNode;
	defaultPrevented: boolean;
	propagationStopped: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

const originals = {
	window: globalThis.window,
	document: globalThis.document,
	Node: globalThis.Node
};

let keyListeners: KeyListener[] = [];
let body: FakeNode;
let dialogs: FakeNode[] = [];

function press(target: FakeNode, init: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
	const event: FakeKeyEvent = {
		key: 's',
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		target,
		defaultPrevented: false,
		propagationStopped: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.propagationStopped = true;
		},
		...init
	};
	for (const listener of keyListeners) listener(event);
	return event;
}

function mount(node: FakeNode, handler: () => void) {
	return saveShortcut(node as unknown as HTMLElement, handler);
}

beforeEach(() => {
	keyListeners = [];
	dialogs = [];
	body = new FakeNode();
	Object.assign(globalThis, {
		Node: FakeNode,
		window: {
			addEventListener: (type: string, listener: KeyListener) => {
				if (type === 'keydown') keyListeners.push(listener);
			},
			removeEventListener: (type: string, listener: KeyListener) => {
				if (type === 'keydown') keyListeners = keyListeners.filter((entry) => entry !== listener);
			}
		},
		document: {
			body,
			documentElement: new FakeNode(),
			querySelectorAll: () => dialogs
		}
	});
});

afterEach(() => {
	Object.assign(globalThis, originals);
});

describe('saveShortcut', () => {
	it('saves only the surface that holds focus', () => {
		const panel = new FakeNode(body);
		const peek = new FakeNode(body);
		const saved: string[] = [];
		const a = mount(panel, () => saved.push('panel'));
		const b = mount(peek, () => saved.push('peek'));

		const event = press(new FakeNode(peek));

		expect(saved).toEqual(['peek']);
		expect(event.defaultPrevented).toBe(true);
		a.destroy();
		b.destroy();
	});

	it('picks the innermost surface when one sits inside another', () => {
		const outer = new FakeNode(body);
		const inner = new FakeNode(outer);
		const saved: string[] = [];
		const a = mount(outer, () => saved.push('outer'));
		const b = mount(inner, () => saved.push('inner'));

		press(new FakeNode(inner));

		expect(saved).toEqual(['inner']);
		a.destroy();
		b.destroy();
	});

	it('falls back to the last used surface when focus is on the page', () => {
		const first = new FakeNode(body);
		const second = new FakeNode(body);
		const saved: string[] = [];
		const a = mount(first, () => saved.push('first'));
		const b = mount(second, () => saved.push('second'));

		first.fire('pointerdown');
		press(body);

		expect(saved).toEqual(['first']);
		a.destroy();
		b.destroy();
	});

	it('does not save when focus is in some other control', () => {
		const editor = new FakeNode(body);
		const chatInput = new FakeNode(body);
		const saved: string[] = [];
		const a = mount(editor, () => saved.push('editor'));

		const event = press(chatInput);

		expect(saved).toEqual([]);
		// Still never the browser's "Save page".
		expect(event.defaultPrevented).toBe(true);
		a.destroy();
	});

	it('does not reach behind an open dialog', () => {
		const panel = new FakeNode(body);
		const dialog = new FakeNode(body);
		dialogs = [dialog];
		const saved: string[] = [];
		const a = mount(panel, () => saved.push('panel'));

		press(body);

		expect(saved).toEqual([]);
		a.destroy();
	});

	it('ignores other chords and stops listening once every surface is gone', () => {
		const panel = new FakeNode(body);
		const saved: string[] = [];
		const a = mount(panel, () => saved.push('panel'));

		press(new FakeNode(panel), { shiftKey: true });
		press(new FakeNode(panel), { key: 'a' });
		expect(saved).toEqual([]);

		a.destroy();
		expect(keyListeners).toHaveLength(0);
	});
});
