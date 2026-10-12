/**
 * Pi credential storage: the installation's device id, refreshes that must
 * never spend one rotating refresh token twice, and accounts saved under a
 * provider id pi-ai has since renamed.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { initializeDatabase } from '$backend/database';
import { settingsQueries } from '$backend/database/queries/settings-queries';
import { engineQueries } from '$backend/database/queries/engine-queries';
import type { Credential } from '@earendil-works/pi-ai';
import { DbCredentialStore, getPiAccountForProvider, getPiDeviceId, getPiProvider, parsePiCredential, serializePiCredential } from './credential';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
	await initializeDatabase();
});

describe('getPiDeviceId', () => {
	test('creates a UUID once and returns it on every later call', () => {
		settingsQueries.delete('pi_device_id');
		const first = getPiDeviceId();
		expect(first).toMatch(UUID);
		expect(getPiDeviceId()).toBe(first);
		expect(settingsQueries.get('pi_device_id')?.value).toBe(first);
	});
});

describe('DbCredentialStore.modify', () => {
	test('serializes refreshes across store instances so a rotating token is spent once', async () => {
		const provider = getPiProvider();
		expect(provider).not.toBeNull();
		const expired: Credential = { type: 'oauth', access: 'a0', refresh: 'r0', expires: Date.now() - 1000 };
		const account = engineQueries.createAccount(provider!.id, `refresh-race-${crypto.randomUUID()}`, serializePiCredential({ provider: 'openai', credential: expired }));

		let refreshes = 0;
		// What pi-ai's Models does: refresh only if the credential it is handed is still expired.
		const refreshIfExpired = async (current: Credential | undefined): Promise<Credential | undefined> => {
			if (current?.type !== 'oauth' || Date.now() < current.expires) return undefined;
			refreshes++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { ...current, access: `a${refreshes}`, refresh: `r${refreshes}`, expires: Date.now() + 3_600_000 };
		};

		// Two streams, two stores, one account row.
		const [a, b] = await Promise.all([
			new DbCredentialStore([account]).modify('openai', refreshIfExpired),
			new DbCredentialStore([account]).modify('openai', refreshIfExpired),
		]);

		expect(refreshes).toBe(1);
		expect(a).toEqual(b);
		const stored = parsePiCredential(engineQueries.getAccount(account.id)?.credential)?.credential;
		expect(stored?.type === 'oauth' && stored.refresh).toBe('r1');
		engineQueries.deleteAccount(account.id);
	});
});

describe('renamed providers', () => {
	test('an account saved under azure-openai-responses resolves as azure, under either id', () => {
		const provider = getPiProvider();
		expect(provider).not.toBeNull();
		const credential: Credential = { type: 'api_key', key: 'k', env: { AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com' } };
		const account = engineQueries.createAccount(provider!.id, `azure-rename-${crypto.randomUUID()}`, serializePiCredential({ provider: 'azure-openai-responses', credential }));

		expect(parsePiCredential(account.credential)?.provider).toBe('azure');
		expect(getPiAccountForProvider('azure')?.id).toBe(account.id);
		expect(getPiAccountForProvider('azure-openai-responses')?.id).toBe(account.id);
		engineQueries.deleteAccount(account.id);
	});

	test('the store serves the credential to pi-ai under the new id', async () => {
		const provider = getPiProvider();
		const credential: Credential = { type: 'api_key', key: 'k2' };
		const account = engineQueries.createAccount(provider!.id, `azure-store-${crypto.randomUUID()}`, serializePiCredential({ provider: 'azure-openai-responses', credential }));

		const store = new DbCredentialStore([account]);
		expect(await store.read('azure')).toEqual(credential);
		expect(await store.read('azure-openai-responses')).toBeUndefined();
		engineQueries.deleteAccount(account.id);
	});
});
