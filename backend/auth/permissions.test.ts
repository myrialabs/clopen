import { describe, expect, test } from 'bun:test';
import { ADMIN_ONLY_ROUTES, checkRouteAccess } from './permissions';

describe('ADMIN_ONLY_ROUTES', () => {
	test('includes high-impact global routes', () => {
		const expectedAdminRoutes = [
			'auth:logout-all',
			'system:clear-data',
			'settings:update',
			'engine:codex-restart',
			'tunnel:remote:start'
		];

		for (const action of expectedAdminRoutes) {
			expect(ADMIN_ONLY_ROUTES.has(action)).toBe(true);
		}
	});
});

describe('checkRouteAccess', () => {
	test('denies non-admin users from auth:logout-all', () => {
		const result = checkRouteAccess('auth:logout-all', true, 'member');
		expect(result).toEqual({ allowed: false, error: 'Admin access required' });
	});

	test('allows admin users to call auth:logout-all', () => {
		const result = checkRouteAccess('auth:logout-all', true, 'admin');
		expect(result).toEqual({ allowed: true });
	});
});
