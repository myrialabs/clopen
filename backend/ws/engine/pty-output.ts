/**
 * Shared helpers for parsing PTY output of engine login flows.
 *
 * Account setup flows (Claude, Codex) run the vendor CLI in a PTY, stream the
 * raw bytes to the UI's xterm.js, and pattern-match a cleaned copy to pull out
 * the auth URL / token. The cleaning lives here so every engine strips the same
 * escape sequences.
 */

// Matches an OSC (Operating System Command) sequence including its payload:
// ESC ] <payload> (BEL | ESC \). Used for window titles (ESC]0;…) and, more
// importantly, hyperlinks (ESC]8;;<url>ESC\<text>ESC]8;;ESC\) — the URL appears
// twice in the byte stream, so leaving the payload behind yields "8;;<url><url>8;;".
const OSC_SEQUENCE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

// Cursor positioning (CSI row;col H/f) — replaced with a newline so the line
// structure of a redrawing TUI survives the strip.
const CURSOR_POSITION = /\x1B\[\d+;\d+[Hf]/g;

// Any remaining CSI / two-character escape sequence.
const ESCAPE_SEQUENCE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(str: string): string {
	return str
		.replace(OSC_SEQUENCE, '')
		.replace(CURSOR_POSITION, '\n')
		.replace(ESCAPE_SEQUENCE, '');
}

/**
 * Extracts the first https:// URL from cleaned PTY output.
 *
 * Stops at whitespace or at a second "https://" — an unterminated hyperlink
 * sequence can glue two copies of the same URL together with no separator.
 */
export function extractHttpsUrl(clean: string): string | null {
	const match = clean.match(/https:\/\/\S+/);
	if (!match) return null;

	const url = match[0];
	const repeat = url.indexOf('https://', 'https://'.length);
	return repeat === -1 ? url : url.substring(0, repeat);
}
