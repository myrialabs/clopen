/**
 * Saved secrets never go back through a model: commands get them by name,
 * and anything a tool reports is masked first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { secretQueries } from '$backend/database/queries';
import { fillSecretRefs, forgetSecretValues, maskSecrets } from './scrub';

const VALUE = 'Tr0ub4dor&3-horse';

beforeAll(async () => {
	await initializeDatabase();
	secretQueries.save({ name: 'test-mail-password', value: VALUE, createdBy: 'assistant' });
	forgetSecretValues();
});

afterAll(() => {
	secretQueries.delete('test-mail-password');
	closeDatabase();
});

describe('secrets by name', () => {
	it('fills {{secret:name}} on its way to a program', () => {
		expect(fillSecretRefs('login --password {{secret:test-mail-password}}')).toBe(`login --password ${VALUE}`);
		expect(() => fillSecretRefs('{{secret:nope-not-saved}}')).toThrow(/no secret/);
	});

	it('masks a saved value anywhere a model would read it, raw or JSON-escaped', () => {
		expect(maskSecrets(`typed → the field reads "${VALUE}"`)).not.toContain(VALUE);
		expect(maskSecrets(JSON.stringify({ text: VALUE }))).not.toContain(VALUE);
		expect(maskSecrets('nothing secret here')).toBe('nothing secret here');
	});
});
