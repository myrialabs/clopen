import { describe, expect, test } from 'bun:test';
import {
	assertSafeGitCommitMessage,
	assertSafeGitPathOperand,
	assertSafeGitRemoteName,
	assertSafeGitRemoteUrl,
	assertSafeGitRevish,
	assertSafeGitShowRef
} from './git-spawn-validation';

describe('assertSafeGitRevish', () => {
	test('accepts typical branch and hash tokens', () => {
		expect(() => assertSafeGitRevish('main', 'x')).not.toThrow();
		expect(() => assertSafeGitRevish('feature/foo-bar', 'x')).not.toThrow();
		expect(() => assertSafeGitRevish('abc123deadbeef', 'x')).not.toThrow();
		expect(() => assertSafeGitRevish('HEAD', 'x')).not.toThrow();
	});

	test('rejects option-shaped values', () => {
		expect(() => assertSafeGitRevish('--output=/tmp/pwn', 'branch')).toThrow(/must not start/);
		expect(() => assertSafeGitRevish('-c', 'branch')).toThrow(/must not start/);
	});

	test('rejects NUL and newlines', () => {
		expect(() => assertSafeGitRevish('a\nb', 'branch')).toThrow();
		expect(() => assertSafeGitRevish('a\0b', 'branch')).toThrow();
	});
});

describe('assertSafeGitRemoteName', () => {
	test('accepts origin', () => {
		expect(() => assertSafeGitRemoteName('origin')).not.toThrow();
	});

	test('rejects spaces and specials', () => {
		expect(() => assertSafeGitRemoteName('my remote')).toThrow(/Invalid git remote name/);
		expect(() => assertSafeGitRemoteName('-bad')).toThrow();
	});
});

describe('assertSafeGitRemoteUrl', () => {
	test('accepts normal https url', () => {
		expect(() => assertSafeGitRemoteUrl('https://github.com/foo/bar.git')).not.toThrow();
	});

	test('rejects argv injection prefix', () => {
		expect(() => assertSafeGitRemoteUrl('-force evil')).toThrow();
	});
});

describe('assertSafeGitShowRef', () => {
	test('rejects colon in ref', () => {
		expect(() => assertSafeGitShowRef('HEAD:readme')).toThrow(/must not contain/);
	});
});

describe('assertSafeGitPathOperand', () => {
	test('allows normal relative paths', () => {
		expect(() => assertSafeGitPathOperand('src/index.ts')).not.toThrow();
	});

	test('rejects newlines', () => {
		expect(() => assertSafeGitPathOperand('a\nb')).toThrow();
	});
});

describe('assertSafeGitCommitMessage', () => {
	test('allows multiline messages', () => {
		expect(() => assertSafeGitCommitMessage('line1\nline2')).not.toThrow();
	});

	test('rejects NUL', () => {
		expect(() => assertSafeGitCommitMessage('a\0b')).toThrow();
	});
});
