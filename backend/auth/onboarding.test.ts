/**
 * Regression tests for the setup-wizard gate.
 *
 * These lock in the two properties that stopped a working install from being
 * sent back through onboarding (and having its settings reset by the wizard):
 * the data directory is isolated while testing, and a missing onboarding marker
 * on an install that already has users resolves to "complete" instead of
 * "never onboarded".
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { getOnboardingState, markOnboardingComplete } from './auth-service';
import { readSystemSettings, writeSystemSettings, SYSTEM_SETTINGS_KEY } from '../settings/system-settings';
import { getClopenDir } from '../utils/paths';
import { authQueries, settingsQueries } from '../database/queries';
import { initializeDatabase, closeDatabase } from '../database';

let testUserId: string;
let originalSettings: string | null = null;

beforeAll(async () => {
	await initializeDatabase();
	originalSettings = settingsQueries.get(SYSTEM_SETTINGS_KEY)?.value ?? null;

	// The self-heal path is only correct for an install that has users, so make
	// sure one exists regardless of what else ran before this file.
	testUserId = `user-${randomUUID()}`;
	authQueries.createUser({
		id: testUserId,
		name: 'Onboarding Test User',
		color: '#000000',
		avatar: 'OT',
		role: 'admin',
		personal_access_token_hash: `hash-${randomUUID()}`,
		created_at: new Date().toISOString()
	});
});

afterAll(() => {
	authQueries.deleteUser(testUserId);
	if (originalSettings === null) {
		settingsQueries.delete(SYSTEM_SETTINGS_KEY);
	} else {
		settingsQueries.set(SYSTEM_SETTINGS_KEY, originalSettings);
	}
	closeDatabase();
});

describe('data directory isolation', () => {
	test('tests never resolve to the production data directory', () => {
		// The whole class of bug this file guards against started here: the test
		// runner sets NODE_ENV=test, which used to fall through to ~/.clopen and
		// let the suite rewrite live rows in the developer's own install.
		const dir = getClopenDir();
		expect(dir).toContain('.clopen-test');
		expect(dir.endsWith('/.clopen')).toBe(false);
	});
});

describe('system settings writes', () => {
	test('merge into the stored blob instead of replacing it', () => {
		writeSystemSettings({ onboarding: 'complete', maxFileSizeMB: 123 });
		writeSystemSettings({ authMode: 'required' });

		const stored = readSystemSettings();
		expect(stored.authMode).toBe('required');
		expect(stored.maxFileSizeMB).toBe(123);
		// The sibling that used to disappear.
		expect(stored.onboarding).toBe('complete');
	});
});

describe('onboarding state', () => {
	test('is complete once the marker is recorded', () => {
		markOnboardingComplete();
		expect(getOnboardingState()).toBe('complete');
	});

	test('respects an explicitly pending wizard so a refresh resumes setup', () => {
		writeSystemSettings({ onboarding: 'pending', onboardingComplete: false });
		expect(getOnboardingState()).toBe('pending');
	});

	test('still honours the legacy onboardingComplete boolean', () => {
		settingsQueries.set(SYSTEM_SETTINGS_KEY, JSON.stringify({ onboardingComplete: true }));
		expect(getOnboardingState()).toBe('complete');
	});

	test('self-heals when the marker is missing but users exist', () => {
		// Exactly the state a stray full-blob write leaves behind.
		settingsQueries.set(SYSTEM_SETTINGS_KEY, JSON.stringify({ authMode: 'required' }));

		expect(getOnboardingState()).toBe('complete');
		// And it is persisted, so the next read cannot flap back to the wizard.
		expect(readSystemSettings().onboarding).toBe('complete');
	});

	test('self-heals when the whole settings row is gone', () => {
		settingsQueries.delete(SYSTEM_SETTINGS_KEY);

		expect(getOnboardingState()).toBe('complete');
		expect(readSystemSettings().onboarding).toBe('complete');
	});
});
