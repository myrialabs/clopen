import { describe, expect, it } from 'bun:test';
import { stripAnsi, extractHttpsUrl } from './pty-output';

const AUTH_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=BgxGqyWmdN7s';

// ESC]8;;<url>ESC\<text>ESC]8;;ESC\ — how Claude Code v2.1.224 prints the URL.
const hyperlink = (url: string, text = url) =>
	`\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`;

describe('stripAnsi', () => {
	it('drops OSC hyperlinks without leaking their payload', () => {
		expect(stripAnsi(`sign in\r\n${hyperlink(AUTH_URL)}\r\n`)).toBe(`sign in\r\n${AUTH_URL}\r\n`);
	});

	it('drops BEL-terminated OSC sequences such as window titles', () => {
		expect(stripAnsi('\x1B]0;Claude Code\x07ready')).toBe('ready');
	});

	it('turns cursor positioning into newlines and removes colour codes', () => {
		expect(stripAnsi('\x1B[1;1Hred \x1B[31mtext\x1B[0m')).toBe('\nred text');
	});
});

describe('extractHttpsUrl', () => {
	it('returns the URL printed as a hyperlink exactly once', () => {
		expect(extractHttpsUrl(stripAnsi(hyperlink(AUTH_URL)))).toBe(AUTH_URL);
	});

	it('stops at a second https:// when a sequence glues two copies together', () => {
		expect(extractHttpsUrl(`8;;${AUTH_URL}${AUTH_URL}8;;`)).toBe(AUTH_URL);
	});

	it('returns null when there is no URL yet', () => {
		expect(extractHttpsUrl('Welcome to Claude Code\n')).toBeNull();
	});
});
