import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { DEFAULT_MAX_FILE_SIZE_MB } from './file-size-limit';

const defaultLimitBytes = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;

// Stub settingsQueries before importing the module under test so the
// `system:settings` lookup never touches a real database during unit tests.
let mockSettingsRow: { key: string; value: string; updated_at: string } | null = null;
await mock.module('../database/queries', () => ({
	settingsQueries: {
		get: (_key: string) => mockSettingsRow,
		getAll: () => [],
		set: () => {},
		delete: () => {}
	}
}));

const { validateFileSize } = await import('./file-size-limit');

describe('validateFileSize (default limit)', () => {
	beforeEach(() => {
		mockSettingsRow = null;
	});

	test('accepts files within the default size limit', () => {
		expect(() => validateFileSize(defaultLimitBytes)).not.toThrow();
	});

	test('rejects files exceeding the default size limit', () => {
		expect(() => validateFileSize(defaultLimitBytes + 1)).toThrow(/File size exceeds/);
	});

	test('accepts small files', () => {
		expect(() => validateFileSize(1024)).not.toThrow();
		expect(() => validateFileSize(0)).not.toThrow();
	});

	test('rejects negative sizes', () => {
		expect(() => validateFileSize(-1)).toThrow(/Invalid file size/);
	});
});

describe('validateFileSize (configurable limit)', () => {
	afterEach(() => {
		mockSettingsRow = null;
	});

	test('honors a higher admin-configured limit', () => {
		mockSettingsRow = {
			key: 'system:settings',
			value: JSON.stringify({ maxFileSizeMB: 1024 }),
			updated_at: ''
		};
		expect(() => validateFileSize(800 * 1024 * 1024)).not.toThrow();
	});

	test('honors a lower admin-configured limit', () => {
		mockSettingsRow = {
			key: 'system:settings',
			value: JSON.stringify({ maxFileSizeMB: 10 }),
			updated_at: ''
		};
		expect(() => validateFileSize(11 * 1024 * 1024)).toThrow(/File size exceeds/);
	});

	test('falls back to the default when the value is malformed', () => {
		mockSettingsRow = {
			key: 'system:settings',
			value: '{ not json',
			updated_at: ''
		};
		expect(() => validateFileSize(defaultLimitBytes)).not.toThrow();
		expect(() => validateFileSize(defaultLimitBytes + 1)).toThrow(/File size exceeds/);
	});

	test('falls back to the default when maxFileSizeMB is non-positive', () => {
		mockSettingsRow = {
			key: 'system:settings',
			value: JSON.stringify({ maxFileSizeMB: 0 }),
			updated_at: ''
		};
		expect(() => validateFileSize(defaultLimitBytes)).not.toThrow();
	});
});
