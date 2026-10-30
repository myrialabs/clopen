/**
 * Which chords need their editing command attached.
 *
 * The failure this guards is silent: on a macOS host a bare Ctrl/⌘+A selects
 * nothing, so "clear then type" appended to the old text, and nothing errored.
 */

import { describe, expect, test } from 'bun:test';
import { editCommandFor, isPasteChord, parseChord } from './keyboard-chords';

describe('parseChord', () => {
	test('splits modifiers from the key and accepts aliases', () => {
		expect(parseChord('Cmd+Shift+z')).toEqual({ modifiers: ['Meta', 'Shift'], key: 'z' });
		expect(parseChord('ctrl + KeyA')).toEqual({ modifiers: ['Control'], key: 'KeyA' });
	});

	test('a modifier named twice is held once', () => {
		expect(parseChord('Control+Ctrl+C').modifiers).toEqual(['Control']);
	});
});

describe('editCommandFor on macOS', () => {
	test('select all needs the command with either primary modifier', () => {
		expect(editCommandFor(['Meta'], 'a', 'darwin')).toBe('SelectAll');
		expect(editCommandFor(['Control'], 'KeyA', 'darwin')).toBe('SelectAll');
	});

	test('copy, cut, undo and redo map to their commands', () => {
		expect(editCommandFor(['Meta'], 'c', 'darwin')).toBe('Copy');
		expect(editCommandFor(['Meta'], 'x', 'darwin')).toBe('Cut');
		expect(editCommandFor(['Meta'], 'z', 'darwin')).toBe('Undo');
		expect(editCommandFor(['Meta', 'Shift'], 'z', 'darwin')).toBe('Redo');
	});
});

describe('editCommandFor elsewhere', () => {
	test('Control is left to the native binding, so nothing runs twice', () => {
		expect(editCommandFor(['Control'], 'a', 'linux')).toBeNull();
		expect(editCommandFor(['Control'], 'z', 'win32')).toBeNull();
	});

	test('Meta has no native binding, so it carries the command', () => {
		expect(editCommandFor(['Meta'], 'a', 'linux')).toBe('SelectAll');
	});
});

describe('chords that are not editing shortcuts', () => {
	test('get no command', () => {
		expect(editCommandFor(['Meta', 'Control'], 'a', 'darwin')).toBeNull();
		expect(editCommandFor(['Alt', 'Meta'], 'a', 'darwin')).toBeNull();
		expect(editCommandFor(['Meta', 'Shift'], 'p', 'darwin')).toBeNull();
		expect(editCommandFor(['Meta'], 'Enter', 'darwin')).toBeNull();
	});
});

describe('isPasteChord', () => {
	test('recognises Ctrl/⌘+V in any spelling', () => {
		expect(isPasteChord(['Meta'], 'v')).toBe(true);
		expect(isPasteChord(['Control'], 'KeyV')).toBe(true);
		expect(isPasteChord(['Control'], 'V')).toBe(true);
	});

	test('leaves other chords alone', () => {
		expect(isPasteChord(['Meta', 'Shift'], 'v')).toBe(false);
		expect(isPasteChord(['Alt', 'Meta'], 'v')).toBe(false);
		expect(isPasteChord([], 'v')).toBe(false);
	});
});
