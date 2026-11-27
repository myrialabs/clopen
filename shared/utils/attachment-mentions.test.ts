import { describe, expect, test } from 'bun:test';
import { mentionedIndexes, removeAllMentions, removeMention, rewriteMentions, shiftMentions, splitMentions } from './attachment-mentions';

describe('attachment mentions', () => {
	test('finds standalone tokens only', () => {
		expect(mentionedIndexes('compare @1 with @3, then (@2) and "@1"')).toEqual([1, 3, 2]);
		expect(mentionedIndexes('mail me@2x.com or use @2x assets')).toEqual([]);
		expect(mentionedIndexes('@4 at the start')).toEqual([4]);
	});

	test('removing deletes the removed file’s tokens and renumbers the rest', () => {
		expect(removeMention('compare @1 with @2 and @3', 2, 3)).toBe('compare @1 with and @2');
		expect(removeMention('Lorem Ipsum @2', 2, 2)).toBe('Lorem Ipsum');
		expect(removeMention('@1 fix this', 1, 1)).toBe('fix this');
		expect(removeMention('look (@2) here\n@2\nnext', 2, 3)).toBe('look () here\n\nnext');
	});

	test('removing leaves numbers beyond the attachments alone', () => {
		expect(removeMention('@1 and @9', 1, 2)).toBe('and @9');
	});

	test('clearing deletes every attachment token', () => {
		expect(removeAllMentions('see @1 and @2, not @7', 2)).toBe('see and, not @7');
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
