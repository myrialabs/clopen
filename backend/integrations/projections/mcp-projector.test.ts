/**
 * Tests for the agent-tools projection.
 *
 * The cases that matter are the ownership ones, because they are the ones that
 * destroy something when they are wrong: adopting a hand-installed server must
 * produce ONE entry rather than a sibling, and disconnecting must hand that
 * server back with the credential the user had on it — not with ours, and not
 * with an empty one.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

import { initializeDatabase, closeDatabase } from '$backend/database';
import { mcpServerQueries, integrationAccountQueries, integrationProjectionQueries } from '$backend/database/queries';
import { integrationAccounts } from '../accounts';

const FIRECRAWL_SLUG = 'firecrawl';

function parseEnv(slug: string): Record<string, string> {
	const row = mcpServerQueries.getBySlug(slug);
	if (!row) return {};
	try {
		return JSON.parse(row.env) as Record<string, string>;
	} catch {
		return {};
	}
}

function clearFixtures(): void {
	for (const account of integrationAccountQueries.getAll()) {
		integrationAccountQueries.remove(account.id);
	}
	const row = mcpServerQueries.getBySlug(FIRECRAWL_SLUG);
	if (row) mcpServerQueries.remove(row.id);
}

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(() => {
	clearFixtures();
});

afterAll(() => {
	clearFixtures();
	closeDatabase();
});

describe('agent-tools projection', () => {
	it('creates a connector row and removes it on disconnect', () => {
		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-first' }
		});

		const row = mcpServerQueries.getBySlug(FIRECRAWL_SLUG);
		expect(row).not.toBe(null);
		expect(parseEnv(FIRECRAWL_SLUG).FIRECRAWL_API_KEY).toBe('fc-first');
		expect(account.projections[0]?.adopted).toBe(false);

		integrationAccounts.disconnect(account.id);
		expect(mcpServerQueries.getBySlug(FIRECRAWL_SLUG)).toBe(null);
	});

	it('adopts a hand-installed server instead of creating a sibling', () => {
		mcpServerQueries.insert({
			slug: FIRECRAWL_SLUG,
			name: 'My Firecrawl',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'firecrawl-mcp'],
			env: { FIRECRAWL_API_KEY: 'fc-mine', EXTRA: 'keep-me' },
			source: 'custom'
		});

		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-account' }
		});

		expect(mcpServerQueries.getBySource('custom').filter((row) => row.slug === FIRECRAWL_SLUG).length).toBe(1);
		expect(account.projections[0]?.adopted).toBe(true);

		const env = parseEnv(FIRECRAWL_SLUG);
		expect(env.FIRECRAWL_API_KEY).toBe('fc-account');
		// An env var the preset says nothing about is the user's, and adopting
		// must not quietly drop it.
		expect(env.EXTRA).toBe('keep-me');
	});

	it('hands an adopted server back with the user credential on disconnect', () => {
		mcpServerQueries.insert({
			slug: FIRECRAWL_SLUG,
			name: 'My Firecrawl',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'firecrawl-mcp'],
			env: { FIRECRAWL_API_KEY: 'fc-mine' },
			source: 'custom'
		});

		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-account' }
		});
		integrationAccounts.disconnect(account.id);

		const row = mcpServerQueries.getBySlug(FIRECRAWL_SLUG);
		expect(row).not.toBe(null);
		expect(parseEnv(FIRECRAWL_SLUG).FIRECRAWL_API_KEY).toBe('fc-mine');
	});

	it('does not re-snapshot on re-projection, so release still restores the original', () => {
		mcpServerQueries.insert({
			slug: FIRECRAWL_SLUG,
			name: 'My Firecrawl',
			transport: 'stdio',
			command: 'npx',
			env: { FIRECRAWL_API_KEY: 'fc-mine' },
			source: 'custom'
		});

		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-account' }
		});

		// A credential rotation re-projects. If that took a fresh snapshot it
		// would capture OUR key, and release would "restore" a token we are about
		// to delete.
		integrationAccounts.updateCredentials(account.id, { apiKey: 'fc-rotated' });
		expect(parseEnv(FIRECRAWL_SLUG).FIRECRAWL_API_KEY).toBe('fc-rotated');

		integrationAccounts.disconnect(account.id);
		expect(parseEnv(FIRECRAWL_SLUG).FIRECRAWL_API_KEY).toBe('fc-mine');
	});

	it('releases the connector when the capability is turned off, and projects again when back on', () => {
		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-toggle' }
		});

		integrationAccounts.setCapabilities(account.id, []);
		expect(mcpServerQueries.getBySlug(FIRECRAWL_SLUG)).toBe(null);
		expect(integrationProjectionQueries.getForAccount(account.id).length).toBe(0);

		integrationAccounts.setCapabilities(account.id, ['agent-tools']);
		expect(parseEnv(FIRECRAWL_SLUG).FIRECRAWL_API_KEY).toBe('fc-toggle');
	});

	it('releases the connector while the account is disabled', () => {
		const account = integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: { apiKey: 'fc-disable' }
		});

		integrationAccounts.setEnabled(account.id, false);
		expect(mcpServerQueries.getBySlug(FIRECRAWL_SLUG)).toBe(null);

		integrationAccounts.setEnabled(account.id, true);
		expect(mcpServerQueries.getBySlug(FIRECRAWL_SLUG)).not.toBe(null);
	});

	it('refuses a second account that would fight over the same connector', () => {
		integrationAccounts.connect({ provider: 'firecrawl', credentials: { apiKey: 'fc-one' } });

		expect(() => integrationAccounts.connect({
			provider: 'firecrawl',
			label: 'Firecrawl (second org)',
			credentials: { apiKey: 'fc-two' }
		})).toThrow();

		// The rejected account must not be left behind half-connected.
		expect(integrationAccountQueries.getByProvider('firecrawl').length).toBe(1);
	});

	it('rejects a connect that is missing a required credential', () => {
		expect(() => integrationAccounts.connect({
			provider: 'firecrawl',
			credentials: {}
		})).toThrow();
		expect(mcpServerQueries.getBySlug(FIRECRAWL_SLUG)).toBe(null);
	});

	it('stores the credential sealed and never returns it to the caller', () => {
		const account = integrationAccounts.connect({
			provider: 'context7',
			credentials: { apiKey: 'ctx7sk-secret' }
		});

		// The account DTO reports which fields are set, not what they are set to.
		expect(account.configuredFields).toEqual(['apiKey']);
		expect(JSON.stringify(account)).not.toContain('ctx7sk-secret');

		const row = mcpServerQueries.getBySlug('context7');
		expect(row).not.toBe(null);
		expect(JSON.parse(row!.headers).CONTEXT7_API_KEY).toBe('ctx7sk-secret');

		integrationAccounts.disconnect(account.id);
		mcpServerQueries.getBySlug('context7') && mcpServerQueries.remove(mcpServerQueries.getBySlug('context7')!.id);
	});
});
