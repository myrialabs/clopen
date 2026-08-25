import { describe, expect, test } from 'bun:test';

import { extractJson } from './structured-helpers';

interface Draft {
	name: string;
	body?: string;
	meta?: { a: { b: number } };
}

// Every case here is a real shape a prompt-engineered engine has produced —
// the parser is the last line of defence before a generation fails, so each
// tolerance it grants gets a regression test.
describe('extractJson', () => {
	test('parses a clean object', () => {
		const parsed = extractJson<Draft>('{"name": "X", "body": "b"}');
		expect(parsed).toEqual({ name: 'X', body: 'b' });
	});

	test('ignores commentary appended after the object, braces and all', () => {
		const response = `{"name": "90s Retro", "body": "# Retro"}

This skill applies { retro } styling. Let me know if you want changes!`;
		expect(extractJson<Draft>(response).name).toBe('90s Retro');
	});

	test('ignores prose before the object', () => {
		const parsed = extractJson<Draft>('Here is the JSON:\n{"name": "X"}\nDone.');
		expect(parsed).toEqual({ name: 'X' });
	});

	test('unwraps a fenced block followed by commentary', () => {
		const parsed = extractJson<Draft>('```json\n{"name": "X"}\n```\n\nHope that helps!');
		expect(parsed).toEqual({ name: 'X' });
	});

	test('repairs raw newlines and tabs inside string values', () => {
		const response = '{"name": "X", "body": "line1\nline2\n\tindented"}';
		expect(extractJson<Draft>(response).body).toBe('line1\nline2\n\tindented');
	});

	test('keeps braces that live inside string values', () => {
		const response = '{"name": "X", "body": "use ${var} and }{ weird"} trailing prose';
		expect(extractJson<Draft>(response).body).toBe('use ${var} and }{ weird');
	});

	test('handles nested objects with trailing text', () => {
		const parsed = extractJson<Draft>('{"name": "X", "meta": {"a": {"b": 1}}} and then some prose');
		expect(parsed).toEqual({ name: 'X', meta: { a: { b: 1 } } });
	});

	test('throws on a truncated response rather than half-parsing it', () => {
		expect(() => extractJson('{"name": "X", "body": "unterminated…')).toThrow(/did not contain valid JSON/);
	});

	test('throws on an empty response', () => {
		expect(() => extractJson('   ')).toThrow(/Empty response/);
	});

	test('previews both ends of a long unparseable response', () => {
		const response = `no json here ${'x'.repeat(600)} tail-marker`;
		expect(() => extractJson(response)).toThrow(/tail-marker/);
	});
});
