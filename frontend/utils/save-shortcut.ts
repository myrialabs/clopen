/**
 * Save Shortcut Action
 *
 * Ctrl/Cmd+S for every editing surface, through one window listener.
 *
 * Each surface used to add its own bubble-phase `keydown` on `window`, which
 * failed two ways. Inside a dialog it never fired: Modal stops keydown at its
 * content box, so the browser's "Save page" sheet opened instead. And outside
 * one it fired for everyone: with the Files panel and a peek both open, one
 * keystroke saved both.
 *
 * So the listener runs in the capture phase, before anything in the tree can
 * stop the event, and it saves exactly one surface: the one holding focus, or
 * — when focus has gone back to the page itself — the one used last.
 */

type SaveHandler = () => void;

interface SaveTarget {
	node: HTMLElement;
	handler: SaveHandler;
	lastActive: number;
}

const targets = new Set<SaveTarget>();
let activityClock = 0;

function isSaveChord(event: KeyboardEvent): boolean {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		event.key.toLowerCase() === 's'
	);
}

function pickTarget(eventTarget: EventTarget | null): SaveTarget | null {
	const origin = eventTarget instanceof Node ? eventTarget : null;
	let innermost: SaveTarget | null = null;
	if (origin) {
		for (const target of targets) {
			if (!target.node.contains(origin)) continue;
			// Nested surfaces: the deepest one is the one being typed in.
			if (!innermost || innermost.node.contains(target.node)) innermost = target;
		}
	}
	if (innermost) return innermost;

	// Nothing focused (a click on empty chrome sends focus to <body>): the
	// surface the user touched last is still the one they mean. Focus sitting
	// in some other control — a chat box, a search field — is not a save.
	const focusIsIdle = !origin || origin === document.body || origin === document.documentElement;
	if (!focusIsIdle) return null;

	// A surface hidden behind an open dialog is not the one on screen.
	const dialogs = Array.from(document.querySelectorAll('[aria-modal="true"]'));
	const topDialog = dialogs[dialogs.length - 1] ?? null;

	let latest: SaveTarget | null = null;
	for (const target of targets) {
		if (!target.node.isConnected) continue;
		if (topDialog && !topDialog.contains(target.node)) continue;
		if (!latest || target.lastActive > latest.lastActive) latest = target;
	}
	return latest;
}

function handleKeydown(event: KeyboardEvent) {
	if (!isSaveChord(event)) return;
	// Inside the app the chord never means "save this web page", whether or
	// not a surface wants it.
	event.preventDefault();
	const target = pickTarget(event.target);
	if (!target) return;
	event.stopPropagation();
	target.handler();
}

function ensureListener() {
	if (targets.size === 1) window.addEventListener('keydown', handleKeydown, true);
}

function releaseListener() {
	if (targets.size === 0) window.removeEventListener('keydown', handleKeydown, true);
}

/**
 * `use:saveShortcut={handler}` — make Ctrl/Cmd+S inside `node` call `handler`.
 * The handler decides whether there is anything to save.
 */
export function saveShortcut(node: HTMLElement, handler: SaveHandler) {
	const target: SaveTarget = { node, handler, lastActive: ++activityClock };
	const markActive = () => {
		target.lastActive = ++activityClock;
	};

	targets.add(target);
	ensureListener();
	node.addEventListener('pointerdown', markActive, true);
	node.addEventListener('focusin', markActive);

	return {
		update(next: SaveHandler) {
			target.handler = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', markActive, true);
			node.removeEventListener('focusin', markActive);
			targets.delete(target);
			releaseListener();
		}
	};
}
