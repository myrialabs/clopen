import { describe, expect, it } from 'bun:test';
import { commandRisk, isBlockedRoute, routeRisk } from './risk';

describe('isBlockedRoute', () => {
	it('keeps credentials, sign-in and wiping Clopen out of reach', () => {
		for (const route of [
			'auth:regenerate-pat',
			'auth:logout-all',
			'system:clear-data',
			'settings:update-system',
			'terminal:pty',
			'agents:codex-accounts-add-api-key',
			'agents:claude-account-setup-start',
			'agents:opencode-account-update-credential',
			'integrations:connect',
			'git:identity-generate-key',
			'db-client:execute-write',
			'files:read-os-clipboard'
		]) {
			expect(isBlockedRoute(route)).toBe(true);
		}
	});

	it('leaves ordinary work reachable', () => {
		for (const route of ['git:status', 'git:commit', 'files:read-file', 'notes:create', 'agents:claude-status', 'preview:browser-tab-navigate']) {
			expect(isBlockedRoute(route)).toBe(false);
		}
	});
});

describe('routeRisk', () => {
	it('reads are reads', () => {
		expect(routeRisk('git:status')).toBe('read');
		expect(routeRisk('files:list-directory')).toBe('read');
		expect(routeRisk('work:pr-files')).toBe('read');
	});

	it('what cannot be undone is irreversible', () => {
		expect(routeRisk('projects:delete')).toBe('irreversible');
		expect(routeRisk('git:discard-all')).toBe('irreversible');
		expect(routeRisk('git:force-pull')).toBe('irreversible');
		expect(routeRisk('work:pr-merge')).toBe('irreversible');
		expect(routeRisk('deployments:deploy')).toBe('irreversible');
	});

	it('everything else is a write', () => {
		expect(routeRisk('git:commit')).toBe('write');
		expect(routeRisk('notes:create')).toBe('write');
	});
});

describe('commandRisk', () => {
	it('flags commands that cannot be undone', () => {
		expect(commandRisk('git push --force origin feature')).toBe('irreversible');
		expect(commandRisk('git push origin main')).toBe('irreversible');
		expect(commandRisk('rm -rf ~/projects')).toBe('irreversible');
		expect(commandRisk('npm publish')).toBe('irreversible');
	});

	it('lets everyday work through', () => {
		expect(commandRisk('bun run test')).toBe('write');
		expect(commandRisk('rm -rf node_modules')).toBe('write');
		expect(commandRisk('git push origin feat/login')).toBe('write');
	});
});
