/**
 * Keyboard chords that actually do something.
 *
 * Editing shortcuts are not handled by the page or by Blink's key handling on
 * every platform. On macOS, ⌘A / ⌘C / ⌘Z are resolved by the Cocoa responder
 * chain *before* Blink sees the key, and a key event dispatched over CDP never
 * passes through it — so on a Mac host neither Ctrl+A nor Meta+A selected
 * anything, and `clearFirst` typed the new text after the old one ("ABC" +
 * "DEF" = "ABCDEF"). The protocol's answer is to send the editing command with
 * the key event, which is what this module does wherever the native binding
 * would not fire.
 *
 * Paste is deliberately not one of them: the headless browser's clipboard is
 * not the one anybody copied into. Callers detect it with `isPasteChord` and
 * paste from the workspace clipboard instead.
 */

import type { KeyInput, Page } from 'puppeteer';

export type Modifier = 'Control' | 'Shift' | 'Alt' | 'Meta';

/** Modifier aliases an agent (or a model trained on other tools) might use. */
export const MODIFIER_ALIASES: Record<string, Modifier> = {
	ctrl: 'Control',
	control: 'Control',
	shift: 'Shift',
	alt: 'Alt',
	option: 'Alt',
	meta: 'Meta',
	cmd: 'Meta',
	command: 'Meta',
	super: 'Meta',
	win: 'Meta'
};

/** Blink editor command names, keyed by the letter of the shortcut. */
const EDIT_COMMANDS: Record<string, string> = {
	a: 'SelectAll',
	c: 'Copy',
	x: 'Cut',
	z: 'Undo',
	y: 'Redo'
};

/** "Control+Shift+K" → modifiers to hold plus the key to press. */
export function parseChord(chord: string): { modifiers: Modifier[]; key: string } {
	const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
	const modifiers: Modifier[] = [];
	let key = '';

	for (const part of parts) {
		const modifier = MODIFIER_ALIASES[part.toLowerCase()];
		if (modifier) {
			if (!modifiers.includes(modifier)) modifiers.push(modifier);
		} else {
			key = part;
		}
	}

	return { modifiers, key };
}

/** "a", "A" and "KeyA" all name the same letter. */
function letterOf(key: string): string | null {
	const code = /^Key([A-Za-z])$/.exec(key);
	if (code) return code[1].toLowerCase();
	return key.length === 1 ? key.toLowerCase() : null;
}

/** Exactly one of Control/Meta, no Alt — the shape of an editing shortcut. */
function primaryModifier(modifiers: Modifier[]): 'Control' | 'Meta' | null {
	if (modifiers.includes('Alt')) return null;
	const hasControl = modifiers.includes('Control');
	const hasMeta = modifiers.includes('Meta');
	if (hasControl === hasMeta) return null;
	return hasControl ? 'Control' : 'Meta';
}

/** Ctrl/⌘+V, in either spelling, on any host. */
export function isPasteChord(modifiers: Modifier[], key: string): boolean {
	return !!primaryModifier(modifiers) && !modifiers.includes('Shift') && letterOf(key) === 'v';
}

/**
 * The editing command a chord has to carry, or null when the key event alone
 * is enough.
 *
 * Both Control and Meta are accepted as the primary modifier on every host —
 * an agent cannot know which OS the server runs on, and "Control+A" meaning
 * select-all everywhere is what it expects. The command is only attached where
 * the native binding would not run, because sending it alongside a binding
 * that does would run it twice: harmless for select-all, a double undo for Z.
 */
export function editCommandFor(
	modifiers: Modifier[],
	key: string,
	platform: NodeJS.Platform = process.platform
): string | null {
	const primary = primaryModifier(modifiers);
	const letter = letterOf(key);
	if (!primary || !letter) return null;

	const shift = modifiers.includes('Shift');
	const command = shift ? (letter === 'z' ? 'Redo' : null) : EDIT_COMMANDS[letter] ?? null;
	if (!command) return null;

	// Off macOS, Blink maps Ctrl+<key> itself. Meta has no binding there.
	const nativeHandles = platform !== 'darwin' && primary === 'Control';
	return nativeHandles ? null : command;
}

/**
 * Press a chord: modifiers down, key, modifiers up in reverse — with the
 * editing command attached when the platform would otherwise ignore it.
 */
export async function pressChord(page: Page, modifiers: Modifier[], key: string): Promise<void> {
	const command = editCommandFor(modifiers, key);

	for (const modifier of modifiers) await page.keyboard.down(modifier);
	try {
		await page.keyboard.press(key as KeyInput, command ? { commands: [command] } : undefined);
	} finally {
		for (const modifier of [...modifiers].reverse()) {
			await page.keyboard.up(modifier).catch(() => {});
		}
	}
}

/** Select everything in the focused field, on any host. */
export async function selectAll(page: Page): Promise<void> {
	await pressChord(page, ['Control'], 'KeyA');
}
