import { describe, expect, test } from 'bun:test';
import { PUBLIC_ROUTES, checkRouteAccess } from './permissions';

describe('checkRouteAccess', () => {
	test('lets anyone reach the sign-in routes', () => {
		for (const action of PUBLIC_ROUTES) {
			expect(checkRouteAccess(action, false)).toEqual({ allowed: true });
		}
	});

	test('requires a signed-in connection for everything else', () => {
		const result = checkRouteAccess('auth:logout-all', false);
		expect(result).toEqual({ allowed: false, error: 'Authentication required' });
	});

	test('lets a signed-in connection reach any route', () => {
		expect(checkRouteAccess('system:clear-data', true)).toEqual({ allowed: true });
	});
});
