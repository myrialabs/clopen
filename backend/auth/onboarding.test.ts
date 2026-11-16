/**
 * Regression tests for the setup-wizard gate.
 *
 * These lock in the properties that keep the wizard honest: the data directory
 * is isolated while testing, the wizard is versioned so an install that only
 * completed an older one goes through the current one once, and the completed
 * version survives anything that rewrites the system-settings blob.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { getOnboardingState, markOnboardingComplete, ONBOARDING_VERSION_KEY } from './auth-service';
import { ONBOARDING_VERSION } from '$shared/constants/onboarding';
import { readSystemSettings, writeSystemSettings, SYSTEM_SETTINGS_KEY } from '../settings/system-settings';
import { getClopenDir } from '../utils/paths';
import { authQueries, settingsQueries } from '../database/queries';
import { initializeDatabase, closeDatabase, getDatabase } from '../database';

let testUserId: string;
let originalSettings: string | null = null;
let originalVersion: string | null = null;

beforeAll(async () => {
	await initializeDatabase();
	originalSettings = settingsQueries.get(SYSTEM_SETTINGS_KEY)?.value ?? null;
	originalVersion = settingsQueries.get(ONBOARDING_VERSION_KEY)?.value ?? null;

	// The self-heal path is only correct for an install that has users, so make
	// sure one exists regardless of what else ran before this file.
	testUserId = `user-${randomUUID()}`;
	authQueries.createUser({
		id: testUserId,
		name: 'Onboarding Test User',
		color: '#000000',
		avatar: 'OT',
		personal_access_token_hash: `hash-${randomUUID()}`,
		created_at: new Date().toISOString()
	});
});

afterAll(() => {
	getDatabase().prepare('DELETE FROM users WHERE id = ?').run(testUserId);
	if (originalSettings === null) {
		settingsQueries.delete(SYSTEM_SETTINGS_KEY);
	} else {
		settingsQueries.set(SYSTEM_SETTINGS_KEY, originalSettings);
	}
	if (originalVersion === null) {
		settingsQueries.delete(ONBOARDING_VERSION_KEY);
	} else {
		settingsQueries.set(ONBOARDING_VERSION_KEY, originalVersion);
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
	test('is complete once the current wizard is recorded', () => {
		markOnboardingComplete();
		expect(getOnboardingState()).toBe('complete');
		expect(readSystemSettings().onboardingVersion).toBe(ONBOARDING_VERSION);
	});

	test('sends an install that completed an older wizard through the current one once', () => {
		// A v0.4 install: the legacy markers say complete, but no version is recorded.
		settingsQueries.delete(ONBOARDING_VERSION_KEY);
		settingsQueries.set(SYSTEM_SETTINGS_KEY, JSON.stringify({ onboarding: 'complete', onboardingComplete: true }));
		expect(getOnboardingState()).toBe('pending');

		markOnboardingComplete();
		expect(getOnboardingState()).toBe('complete');
	});

	test('an older recorded version is not enough', () => {
		settingsQueries.set(ONBOARDING_VERSION_KEY, String(ONBOARDING_VERSION - 1));
		expect(getOnboardingState()).toBe('pending');
	});

	test('the completed version survives a stray full-blob write', () => {
		markOnboardingComplete();
		// Exactly the state a stray full-blob write leaves behind.
		settingsQueries.set(SYSTEM_SETTINGS_KEY, JSON.stringify({ authMode: 'required' }));
		expect(getOnboardingState()).toBe('complete');
	});

	test('the completed version survives the settings row disappearing', () => {
		markOnboardingComplete();
		settingsQueries.delete(SYSTEM_SETTINGS_KEY);
		expect(getOnboardingState()).toBe('complete');
	});
});
