/**
 * Paste, the way a browser does it.
 *
 * A real paste is two steps: a `paste` event the page may handle itself (rich
 * editors and spreadsheets always do — they read `clipboardData` and insert on
 * their own), and, only if nobody cancelled it, the text inserted at the caret.
 * Inserting alone skipped the first step, so a spreadsheet grid that only
 * listens for `paste` ignored it entirely.
 *
 * The text comes from the caller (the workspace clipboard), never from the
 * headless browser's own clipboard, which is not the one anybody copied into.
 */

import type { Page } from 'puppeteer';

export type PasteOutcome = 'handled-by-page' | 'inserted';

/**
 * Raise `paste` on the focused element, in whichever frame holds focus, then
 * insert the text unless the page took care of it.
 */
export async function pasteText(page: Page, text: string): Promise<PasteOutcome> {
	let handled = false;
	let dispatched = false;

	// The focused frame first; the main frame if none admits to focus (a
	// headless window is not always "focused" in the document's own opinion).
	const frames = page.frames().filter((frame) => !frame.isDetached());
	const ordered = [...frames.slice(1), frames[0]].filter(Boolean);

	for (const frame of ordered) {
		try {
			const result = await frame.evaluate(
				(value: string, isMain: boolean) => {
					let active: Element | null = document.activeElement;
					while (active && (active as HTMLElement).shadowRoot?.activeElement) {
						active = (active as HTMLElement).shadowRoot!.activeElement;
					}

					// Focus lives in a child frame; that frame dispatches instead.
					if (active && active.tagName === 'IFRAME') return null;
					const focusedHere = document.hasFocus() && active && active !== document.body;
					if (!focusedHere && !isMain) return null;

					const target = active ?? document.body;
					const data = new DataTransfer();
					data.setData('text/plain', value);
					const event = new ClipboardEvent('paste', {
						clipboardData: data,
						bubbles: true,
						cancelable: true,
						composed: true
					});
					target.dispatchEvent(event);
					return event.defaultPrevented;
				},
				text,
				frame === page.mainFrame()
			);

			if (result === null) continue;
			handled = result;
			dispatched = true;
			break;
		} catch {
			// Frame navigated or detached mid-paste; try the next one.
		}
	}

	if (dispatched && handled) return 'handled-by-page';

	// `Input.insertText` lands wherever focus is, in any frame, and raises the
	// same beforeinput/input events typing would.
	const client = await page.createCDPSession();
	try {
		await client.send('Input.insertText', { text });
	} finally {
		await client.detach().catch(() => {});
	}
	return 'inserted';
}
