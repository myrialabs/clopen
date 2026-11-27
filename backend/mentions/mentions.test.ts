import { describe, expect, it } from 'bun:test';
import { unifiedDiff } from './diff';
import { rank, stripAnsi } from './shared';
import { terminalText } from './sources/terminal';

describe('mention helpers', () => {
	it('write a unified diff with context around each change', async () => {
		const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
		const after = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
		expect(await unifiedDiff('x.txt', before, after)).toBe(
			['--- a/x.txt', '+++ b/x.txt', '@@ -1,6 +1,6 @@', ' a', ' b', '-c', '+C', ' d', ' e', ' f', '@@ -8,3 +8,4 @@', ' h', ' i', ' j', '+k'].join('\n')
		);
		expect(await unifiedDiff('x.txt', 'same', 'same')).toBe('');
		expect(await unifiedDiff('new.txt', '', 'hello')).toBe(['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,1 @@', '+hello'].join('\n'));
	});

	it('turn a terminal screen into the text a person saw', () => {
		expect(stripAnsi('\u001b[1;31merror\u001b[0m: \u001b]0;title\u0007done')).toBe('error: done');
		expect(terminalText('$ ls   \r\nfile\r\n\r\n\r\n\r\n$ \u001b[K   ')).toBe('$ ls\nfile\n\n$');
	});

	it('rank by match, keeping the given order with no query', () => {
		const items = ['readme.md', 'src/app.ts', 'src/apple.ts'];
		expect(rank(items, '', (item) => [item], 2)).toEqual(['readme.md', 'src/app.ts']);
		expect(rank(items, 'app', (item) => [item], 5)).toEqual(['src/app.ts', 'src/apple.ts']);
	});
});
