import { describe, expect, test } from 'bun:test';
import { mentionedIndexes, removeMention, rewriteMentions, shiftMentions, splitMentions } from './attachment-mentions';

describe('attachment mentions', () => {
	test('finds standalone tokens only', () => {
		expect(mentionedIndexes('compare @1 with @3, then (@2) and "@1"')).toEqual([1, 3, 2]);
		expect(mentionedIndexes('mail me@2x.com or use @2x assets')).toEqual([]);
		expect(mentionedIndexes('@4 at the start')).toEqual([4]);
	});

	test('removing renumbers the rest and names the removed file', () => {
		const text = 'see @1, @2 and @3';
		expect(removeMention(text, 2, 3, 'b.png')).toBe('see @1, "b.png" and @2');
	});

	test('removing leaves numbers beyond the attachments alone', () => {
		expect(removeMention('@1 and @9', 1, 2, 'a.png')).toBe('"a.png" and @9');
	});

	test('shifting moves only the appended message’s own numbers', () => {
		expect(shiftMentions('@1 vs @2 vs @7', 3, 2)).toBe('@4 vs @5 vs @7');
		expect(shiftMentions('@1', 0, 1)).toBe('@1');
	});

	test('rewrite can leave a token as it is', () => {
		expect(rewriteMentions('@1 @2', (n) => (n === 1 ? null : 5))).toBe('@1 @5');
	});

	test('split keeps the text around in-range tokens', () => {
		expect(splitMentions('look at @2 and @5.', 3)).toEqual(['look at ', 2, ' and @5.']);
		expect(splitMentions('@1', 1)).toEqual([1]);
	});
});
