/**
 * Copy text to the clipboard, including where the modern API is unavailable.
 *
 * `navigator.clipboard` only exists in a SECURE CONTEXT. Clopen is regularly
 * reached over plain HTTP — a LAN address, a VPS IP, a phone on the same
 * network — and on those origins the property is simply undefined, so a bare
 * `navigator.clipboard.writeText()` throws a TypeError and the copy silently
 * does nothing. That is precisely the deployment this project is built for, so
 * the fallback is not an edge case here.
 *
 * The fallback is the deprecated `execCommand('copy')`, which still works in
 * every browser Clopen supports and does not require a secure context. It is
 * kept behind the modern path so it disappears the moment the origin is HTTPS.
 */

import { debug } from '$shared/utils/logger';

/** Returns false when the text could not be copied, so callers can say so. */
export async function copyText(text: string): Promise<boolean> {
	if (!text) return false;

	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (error) {
			// Permission denied, or a document that is not focused. The legacy
			// path sometimes still succeeds, so fall through rather than give up.
			debug.warn('websocket', 'Clipboard API refused, falling back:', error);
		}
	}

	return legacyCopy(text);
}

/**
 * Selection-based copy.
 *
 * The textarea is positioned off-screen rather than hidden: a `display: none`
 * or `visibility: hidden` element cannot hold a selection, so the copy would
 * report success and put nothing on the clipboard.
 */
function legacyCopy(text: string): boolean {
	const holder = document.createElement('textarea');
	holder.value = text;
	holder.setAttribute('readonly', '');
	holder.style.position = 'fixed';
	holder.style.top = '-9999px';
	holder.style.opacity = '0';
	document.body.appendChild(holder);

	try {
		holder.select();
		holder.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} catch (error) {
		debug.warn('websocket', 'Clipboard fallback failed:', error);
		return false;
	} finally {
		document.body.removeChild(holder);
	}
}
